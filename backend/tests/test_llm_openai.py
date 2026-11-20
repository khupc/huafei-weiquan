import json

import httpx

from app import rules
from app.llm.openai_compat import OpenAICompatProvider


def provider(reply):
    """A provider whose HTTP calls are answered by `reply(request_json) -> content | Exception`."""
    seen = []

    def handler(request: httpx.Request):
        body = json.loads(request.content)
        seen.append({"auth": request.headers["authorization"], "url": str(request.url), "body": body})
        out = reply(body)
        if isinstance(out, Exception):
            return httpx.Response(500, json={"error": str(out)})
        return httpx.Response(200, json={"choices": [{"message": {"content": out}}]})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    return OpenAICompatProvider(base_url="https://example.test/v1", model="m", api_key="k", client=client), seen


def test_extract_parses_json_and_computes_missing_locally():
    p, seen = provider(lambda b: '好的：{"carrier": "CMCC", "issue": "号码被注销", "expectation": "恢复号码", '
                                 '"prior_contact_status": null, "primary_category": "unknown"}')
    e = p.extract("我的移动号码被注销了，想恢复号码", {})
    assert e.carrier == "CMCC" and e.issue == "号码被注销" and e.expectation == "恢复号码"
    assert e.missing_critical_slots == ["prior_contact"] and e.next_action == "ask"
    assert seen[0]["auth"] == "Bearer k" and seen[0]["url"] == "https://example.test/v1/chat/completions"


def test_analyze_sends_library_and_returns_model_choice():
    p, seen = provider(lambda b: json.dumps({"law_ids": ["miit_service_std"], "demands": [
        {"text": "恢复号码", "feasibility": "中", "law_ids": ["miit_service_std"], "reason": "号码未放出", "from_user": True}]},
        ensure_ascii=False))
    a = p.analyze({"issue": "号码被注销", "expectation": "恢复号码"}, rules.laws())
    assert a.law_ids == ["miit_service_std"] and a.demands[0].from_user
    assert "miit_service_std｜工信部《电信服务规范》" in seen[0]["body"]["messages"][1]["content"]


def test_failure_falls_back_to_keyword_stub():
    p, _ = provider(lambda b: RuntimeError("down"))
    e = p.extract("联通乱扣费30元，打过客服没解决", {})
    assert e.carrier == "CUCC" and e.primary_category == "S1"  # stub result
    p, _ = provider(lambda b: "不是 JSON")
    assert p.analyze({"primary_category": "S1"}, rules.laws()).law_ids[0] == "telecom_reg_40"
