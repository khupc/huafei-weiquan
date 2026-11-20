"""Deterministic card rendering: every law ref, hotline, red line and template comes
from the rule library; only the summary and complaint body come from the model."""
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


def demands(slots: dict) -> list[str]:
    return [c["demand"] for c in _cats(slots)] or ["请尽快核实并依法处理上述问题"]


def confirm_card(slots: dict) -> dict:
    t = rules.templates()["node1"]
    return {
        "carrier": slots.get("carrier"),
        "province": slots.get("province"),
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


def node2(slots: dict) -> dict:
    t = rules.templates()["node2"]
    carrier = _carrier(slots)
    cats = _cats(slots)
    primary = cats[0] if cats else {"law_refs": "", "demand": demands(slots)[0]}
    fill = {
        "fact_line": _short(slots.get("summary", ""), 80),
        "law_refs": primary["law_refs"],
        "demand": primary["demand"],
    }
    script = [
        {"label": s["label"], "text": s["text"].format(**fill)}
        for s in t["script"]
        if not (s["label"] == "注入法条" and not primary["law_refs"])
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
        "call_date": slots.get("call_date") or "",
        "agent_id": slots.get("agent_id") or "未提供",
        "ticket_id": slots.get("ticket_id") or "",
    }
    return (t["prior_record"] if fill["ticket_id"] else t["prior_record_no_ticket"]).format(**fill)


def company_name(slots: dict) -> str:
    tpl = _carrier(slots).get("company_template", "")
    return tpl.format(province=slots.get("province") or "")


def complaint_body(slots: dict, llm: LLMProvider) -> str:
    raw = llm.rewrite_complaint(slots, prior_record(slots), "；".join(demands(slots)))
    return guardrails.apply(raw, slots)


def node3(slots: dict, generated: dict) -> dict:
    t = rules.templates()["node3"]
    ds = demands(slots)
    return {
        "modules": [
            {"key": "company", "title": "申诉企业全称", "text": company_name(slots)},
            {"key": "prior_record", "title": "前置投诉记录", "text": prior_record(slots)},
            {"key": "complaint_body", "title": "申诉正文", "text": generated.get("complaint_body", ""), "max_chars": t["body_max_chars"]},
            {"key": "demands", "title": "具体诉求", "text": "\n".join(f"{i}. {d}" for i, d in enumerate(ds, 1))},
        ],
        "nav_steps": t["nav_steps"],
    }


def node4(slots: dict) -> dict:
    t = rules.templates()["node4"]
    return {
        "general_red_lines": t["general_red_lines"],
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
