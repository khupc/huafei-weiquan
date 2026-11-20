"""Keyword/regex stand-in for the model, so the whole flow runs without one.
Good enough for demos and tests; not for real users."""
import re

from .. import guardrails, rules
from .base import Extraction

_CARRIER_WORDS = {"CMCC": ["移动", "10086"], "CUCC": ["联通", "10010"], "CTCC": ["电信", "10000"], "CBN": ["广电", "10099"]}
_AMOUNT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:元|块)")
_TIME_RE = re.compile(r"((?:今年|去年|前年|\d{4}年)?\s*\d{1,2}\s*月(?:份)?(?:\d{1,2}[日号])?(?:开始|起|以来)?|上个月|这个月|最近\S{0,3}个月|半年|一年多?)")
_TICKET_RE = re.compile(r"工单(?:号|编号)?[:：\s是为]*([A-Za-z0-9-]{6,})")
_BUSINESS_RE = re.compile(r"([一-龥A-Za-z0-9]{2,10}(?:业务|会员|彩铃|套餐|包))")
_NO_CONTACT = ["没打过", "还没打", "没联系", "还没联系", "没找过", "没有找", "没打客服", "还没打过"]
_VERBAL = ["打过", "联系过", "找过客服", "客服说", "客服不", "投诉过", "没解决", "打了客服"]
_EMOTION_ONLY_MAX = 12


class StubProvider:
    def extract(self, text: str, known: dict) -> Extraction:
        e = Extraction()
        for code, words in _CARRIER_WORDS.items():
            if any(w in text for w in words):
                e.carrier = code
                break

        hits = []
        for code, cat in rules.categories().items():
            positions = [text.find(k) for k in cat["stub_keywords"] if k in text]
            if positions:
                hits.append((min(positions), code))
        hits.sort()
        if hits:
            e.primary_category = hits[0][1]
            e.secondary_categories = [c for _, c in hits[1:]]

        if m := _AMOUNT_RE.search(text):
            e.amount = float(m.group(1))
        if m := _TIME_RE.search(text):
            e.duration_or_time = m.group(1).strip()
        if m := _BUSINESS_RE.search(text):
            e.business_or_plan_name = m.group(1)

        # Strict judgement (spec 3.2-2): ticket_logged only with an explicit ticket number.
        if m := _TICKET_RE.search(text):
            e.prior_contact_status, e.ticket_id = "ticket_logged", m.group(1)
        elif any(w in text for w in _NO_CONTACT):
            e.prior_contact_status = "none"
        elif any(w in text for w in _VERBAL):
            e.prior_contact_status = "verbal_only"

        category = e.primary_category if e.primary_category != "unknown" else known.get("primary_category", "unknown")
        prior = e.prior_contact_status or known.get("prior_contact_status")
        if category in (None, "unknown"):
            e.missing_critical_slots.append("core_issue")
        if not prior:
            e.missing_critical_slots.append("prior_contact")
        e.next_action = "ask" if e.missing_critical_slots else "confirm"
        e.is_emotion_only = len(text) <= _EMOTION_ONLY_MAX and e.primary_category == "unknown" and e.amount is None
        return e

    def ask(self, missing: list[str], text: str) -> str:
        asks = rules.templates()["node1"]["ask"]
        key = "both" if len(missing) > 1 else missing[0]
        return asks[key]

    def summarize(self, texts: list[str], slots: dict) -> str:
        text = "".join(t.rstrip("。.！!") + "。" for t in texts if t.strip())
        return guardrails.strip_emotion(text)

    def rewrite_complaint(self, slots: dict, prior_record: str, demand: str) -> str:
        carrier = rules.carriers().get(slots.get("carrier") or "", {}).get("name", "")
        parts = [f"本人为{carrier}用户。" if carrier else "", slots.get("summary", "")]
        if slots.get("amount"):
            parts.append(f"涉及金额{slots['amount']:g}元。")
        parts.append(prior_record)
        parts.append(f"现申诉请求：{demand}。")
        return "".join(parts)

    def parse_screenshot(self, image: bytes, mime: str) -> dict:
        return {}  # needs a multimodal model; see README
