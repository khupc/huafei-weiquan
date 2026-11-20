"""Deterministic card rendering: every law name, hotline, red line and template comes
from the rule library. The model supplies the summary, the advice (law ids + demand
options, already checked by guardrails) and the complaint body."""
from . import guardrails, rules
from .llm import LLMProvider


def _cats(slots: dict) -> list[dict]:
    codes = [slots.get("primary_category")] + list(slots.get("secondary_categories") or [])
    table = rules.categories()
    return [table[c] for c in codes if c in table]


def _carrier(slots: dict) -> dict:
    return rules.carriers().get(slots.get("carrier") or "", {})


def _short(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit]
    last = cut.rfind("。")
    return cut[: last + 1] if last > limit // 2 else cut + "…"


def _laws(ids: list[str]) -> list[dict]:
    table = rules.laws()
    return [{"id": i, **table[i]} for i in ids if i in table]


def demands(slots: dict) -> list[str]:
    """What the user chose on the advice page; older cases fall back to the category demand."""
    return (slots.get("chosen_demands") or [c["demand"] for c in _cats(slots)]
            or ["请尽快核实并依法处理上述问题"])


def chosen_law_names(slots: dict) -> list[str]:
    return [law["name"] for law in _laws(slots.get("chosen_law_ids") or [])]


def confirm_card(slots: dict) -> dict:
    t = rules.templates()["node1"]
    return {
        "carrier": slots.get("carrier"),
        "province": slots.get("province"),
        "city": slots.get("city"),
        "expectation": slots.get("expectation"),
        "carrier_options": {k: v["name"] for k, v in rules.carriers().items()},
        "province_options": rules.provinces(),
        "summary": slots.get("summary", ""),
        "amount": slots.get("amount"),
        "duration_or_time": slots.get("duration_or_time"),
        "prior_contact_status": slots.get("prior_contact_status"),
        "prior_contact_options": t["quick_replies"],
        "ticket_id": slots.get("ticket_id"),
        "agent_id": slots.get("agent_id"),
        "call_date": slots.get("call_date"),
    }


def advice(slots: dict, analysis: dict) -> dict:
    t = rules.templates()["node1"]["advice"]
    names = {law["id"]: law["name"] for law in _laws(list(rules.laws()))}
    return {
        "expectation": slots.get("expectation"),
        "laws": _laws(analysis.get("law_ids", [])),
        "no_law": None if analysis.get("law_ids") else t["no_law"],
        "demands": [{**d, "law_names": [names[i] for i in d["law_ids"] if i in names]}
                    for d in analysis.get("demands", [])],
        "disclaimer": t["disclaimer"],
    }


def node2(slots: dict) -> dict:
    t = rules.templates()["node2"]
    carrier = _carrier(slots)
    law_refs = "、".join(chosen_law_names(slots))
    fill = {
        "fact_line": _short(slots.get("summary", ""), 80),
        "law_refs": law_refs,
        "demand": "；".join(demands(slots)),
    }
    script = [
        {"label": s["label"], "text": s["text"].format(**fill)}
        for s in t["script"]
        if not (s["label"] == "注入法条" and not law_refs)
    ]
    return {
        "principles": t["principles"],
        "transfer": {"hotline": carrier.get("hotline"), "tip": carrier.get("transfer_tip"), "carrier_name": carrier.get("name")},
        "script": script,
        "closing": t["closing"],
    }


def prior_record(slots: dict) -> str:
    t = rules.templates()["node3"]
    fill = {
        "hotline": _carrier(slots).get("hotline", "客服热线"),
        "call_date": slots.get("call_date") or "近日",
        "agent_id": slots.get("agent_id") or "未提供",
        "ticket_id": slots.get("ticket_id") or "",
    }
    return (t["prior_record"] if fill["ticket_id"] else t["prior_record_no_ticket"]).format(**fill)


def complaint_body(slots: dict, llm: LLMProvider) -> str:
    """The model's text has every law citation stripped; the laws the user's demands rest on
    are put back from the library, by name only."""
    names = chosen_law_names(slots)
    law_line = f"上述情况涉及{'、'.join(names)}的相关规定。" if names else ""
    raw = llm.rewrite_complaint(slots, prior_record(slots), "；".join(demands(slots)))
    body = guardrails.apply(raw, slots, reserve=len(law_line))
    if not law_line:
        return body
    at = body.find("现申诉请求")
    return body[:at] + law_line + body[at:] if at >= 0 else body + law_line


def form_guide(slots: dict) -> list[dict]:
    """Field-by-field answers for the 12300 appeal form, in the form's own order."""
    carrier = _carrier(slots).get("name", "你的运营商")
    has_ticket = bool(slots.get("ticket_id"))
    return [
        {"label": "企业", "value": f"基础电信运营商 → {carrier}"},
        {"label": "所属地区", "value": f"{slots.get('province') or '号码归属省份'} → {slots.get('city') or '号码归属城市'}"},
        {"label": "您是否向企业投诉过", "value": "是"},
        {"label": "企业是否反馈处理结果", "value": "客服给过明确答复选“是”，一直没回音选“否”"},
        {"label": "处理结果是否满意", "value": "否"},
        {"label": "申诉问题涉及号码", "value": "填出问题的手机号或宽带账号"},
        {"label": "投诉编码", "value": slots["ticket_id"] if has_ticket else "没有工单号可以不填"},
    ]


def node3(slots: dict, generated: dict) -> dict:
    t = rules.templates()["node3"]
    modules = [{"key": "complaint_body", "title": "申诉内容", "text": generated.get("complaint_body", ""),
                "min_chars": t["body_min_chars"], "max_chars": t["body_max_chars"]}]
    if slots.get("ticket_id"):
        modules.append({"key": "ticket_id", "title": "投诉编码（工单号）", "text": slots["ticket_id"]})
    return {"form_guide": form_guide(slots), "modules": modules, "nav_steps": t["nav_steps"]}


def node4(slots: dict) -> dict:
    t = rules.templates()["node4"]
    return {
        "general_red_lines": t["general_red_lines"],
        "my_lines": ([f"你的底线：{slots['expectation']}"] if slots.get("expectation") else [])
                    + [f"“{d}”没在官方渠道落实前，不点满意、不撤诉" for d in slots.get("chosen_demands") or []],
        "scenario_lines": [{"name": c["name"], "lines": c["bottom_lines"]} for c in _cats(slots)],
        "escalate_after_days": t["escalate_after_days"],
    }


def node5(slots: dict, t0) -> dict:
    t = rules.templates()["node5"]
    t0_date = t0.strftime("%Y年%m月%d日") if t0 else ""
    amount = slots.get("amount") or 0
    return {
        "supplement": t["supplement"].format(t0_date=t0_date),
        "original_facts": slots.get("summary", ""),
        "channels": t["channels"],
        "small_claims": t["small_claims"] if amount > t["small_claims_threshold"] else None,
    }
