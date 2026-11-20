"""Any OpenAI-compatible chat API: Hugging Face router (default), DashScope/Qwen, Zhipu GLM.

Env: LLM_BASE_URL, LLM_MODEL, and LLM_API_KEY (falls back to HF_TOKEN).
If a call fails or returns unusable JSON, that one call falls back to the keyword stub,
so the flow never dead-ends on a model hiccup.
"""
import json
import logging
import os
import re

import httpx

from .. import guardrails, rules
from .base import Analysis, Extraction
from .stub import StubProvider

log = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://router.huggingface.co/v1"
DEFAULT_MODEL = "Qwen/Qwen2.5-72B-Instruct"

_EXTRACT_PROMPT = """你是话费维权助手的信息提取模块。用户的话已脱敏（<PHONE_MASKED> 等是占位符）。
只输出一个 JSON 对象，字段如下，用户没提到的填 null：
- carrier: 运营商，CMCC(移动) / CUCC(联通) / CTCC(电信) / CBN(广电)
- issue: 用一句话说清楚出了什么问题（例如“号码被运营商注销”），用户还没说具体问题时为 null
- expectation: 用户希望怎么解决、最低能接受什么，尽量用用户原话
- primary_category: 统计标签，S1 乱扣费 / S2 改套餐受阻 / S3 隐形合约与违约金 / S4 营销骚扰 / S5 停机与靓号 / S6 宽带与押金 / S7 网络质量，都不像就填 unknown
- amount: 涉及金额（数字，单位元）
- duration_or_time: 发生时间或持续时长，原话
- business_or_plan_name: 涉及的业务或套餐名
- prior_contact_status: none(没联系过客服) / verbal_only(联系过但没有工单号) / ticket_logged(只有明确给出工单号时才用)
- ticket_id: 工单号
- is_emotion_only: 只有情绪、没有任何事实时为 true"""

_SUMMARY_PROMPT = """把用户说的话整理成一段客观的事实陈述，供用户核对，用第一人称“我”。
要求：按时间顺序；只写用户说过的事实，不推测、不评论、不引用法条、不提赔偿倍数；
去掉情绪化的词；去掉 <PHONE_MASKED> 这类占位符；不超过 150 字。只输出这段话本身。"""

_ANALYZE_PROMPT = """你是话费维权助手的分析模块。根据事实，从给定的法条库里挑出适用的条款，并列出可选诉求、逐个分析可行性。
只输出一个 JSON 对象：
{"law_ids": [...], "demands": [{"text": "...", "feasibility": "高|中|低", "law_ids": [...], "reason": "...", "from_user": true|false}]}
规则：
1. law_ids 只能用法条库里出现的 id，没有适用的就给空数组，绝不能编造条款。
2. demands 给 2 到 4 个。用户说过期望时，第一个必须是用户的期望（from_user 为 true，尽量保留原话），即使可行性低也要列出。
3. feasibility 根据事实判断成功的可能性；reason 一句话说明理由，不超过 40 字，不写法条条文号，不写赔偿倍数。
4. 诉求要具体、可执行，例如“退还 8 月以来多扣的 90 元”，不要写空话。"""

_REWRITE_PROMPT = """把下面的信息写成一段提交给工信部 12300 的申诉内容，用第一人称“本人”。
要求：客观、克制、不带情绪；依次写清事实经过、前置投诉记录（原样保留）、申诉请求；
不引用任何法条，不写赔偿倍数；保留工单编号、客服工号、金额；总长 60 到 420 字。只输出这段话本身。"""


def _json_obj(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("model returned no JSON object")
    return json.loads(m.group(0))


class OpenAICompatProvider:
    def __init__(self, base_url: str | None = None, model: str | None = None, api_key: str | None = None,
                 client: httpx.Client | None = None):
        self.base_url = (base_url or os.getenv("LLM_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.model = model or os.getenv("LLM_MODEL") or DEFAULT_MODEL
        self.api_key = api_key or os.getenv("LLM_API_KEY") or os.getenv("HF_TOKEN")
        if not self.api_key:
            raise ValueError("LLM_PROVIDER=openai needs LLM_API_KEY or HF_TOKEN")
        self.client = client or httpx.Client(timeout=60)
        self.fallback = StubProvider()

    def _chat(self, system: str, user: str, temperature: float = 0.2) -> str:
        r = self.client.post(
            f"{self.base_url}/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={"model": self.model, "temperature": temperature,
                  "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]},
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"].strip()

    def _try(self, name: str, fn, fallback):
        try:
            return fn()
        except Exception as exc:  # network, HTTP, or malformed output: degrade this one call
            log.warning("LLM %s failed, using keyword fallback: %s", name, exc)
            return fallback()

    def extract(self, text: str, known: dict) -> Extraction:
        def call():
            data = _json_obj(self._chat(_EXTRACT_PROMPT, text, 0))
            e = Extraction.model_validate({k: v for k, v in data.items() if v is not None})
            prior = e.prior_contact_status or known.get("prior_contact_status")
            if not (e.issue or known.get("issue")):
                e.missing_critical_slots.append("core_issue")
            if not prior:
                e.missing_critical_slots.append("prior_contact")
            e.next_action = "ask" if e.missing_critical_slots else "confirm"
            return e
        return self._try("extract", call, lambda: self.fallback.extract(text, known))

    def ask(self, missing: list[str], text: str) -> str:
        return self.fallback.ask(missing, text)  # fixed, reviewed wording

    def summarize(self, texts: list[str], slots: dict) -> str:
        def call():
            out = self._chat(_SUMMARY_PROMPT, "\n".join(texts))
            return guardrails.strip_emotion(guardrails.strip_fabricated_law(out))
        return self._try("summarize", call, lambda: self.fallback.summarize(texts, slots))

    def analyze(self, slots: dict, laws: dict) -> Analysis:
        def call():
            catalog = "\n".join(f"{i}｜{v['name']}｜第一版用于：{v['used_for']}" for i, v in laws.items())
            facts = {k: slots.get(k) for k in ("carrier", "issue", "summary", "amount", "duration_or_time",
                                               "business_or_plan_name", "prior_contact_status", "expectation")}
            user = f"事实：{json.dumps(facts, ensure_ascii=False)}\n\n法条库（id｜名称｜说明）：\n{catalog}"
            return Analysis.model_validate(_json_obj(self._chat(_ANALYZE_PROMPT, user)))
        return self._try("analyze", call, lambda: self.fallback.analyze(slots, laws))

    def rewrite_complaint(self, slots: dict, prior_record: str, demand: str) -> str:
        def call():
            carrier = rules.carriers().get(slots.get("carrier") or "", {}).get("name", "")
            user = (f"运营商：{carrier}\n事实：{slots.get('summary', '')}\n涉及金额：{slots.get('amount') or '无'}\n"
                    f"前置投诉记录：{prior_record}\n申诉请求：{demand}")
            return self._chat(_REWRITE_PROMPT, user)
        return self._try("rewrite", call, lambda: self.fallback.rewrite_complaint(slots, prior_record, demand))

    def parse_screenshot(self, image: bytes, mime: str) -> dict:
        return {}  # needs a vision model; text-only for now
