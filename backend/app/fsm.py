"""Spec 3.1: the 5-node state machine. All transitions go through `_move` so every
jump is logged to case_event_logs."""
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import render, rules
from .llm import LLMProvider
from .models import Case, CaseClosingSurvey, CaseEventLog, SftFeedbackSample

INTAKE = "NODE_1_INTAKE"
CONFIRM = "NODE_1_CONFIRM_CARD"
CALL = "NODE_2_CALL"
APPEAL = "NODE_3_APPEAL"
CALLBACK = "NODE_4_CALLBACK"
ESCALATE = "NODE_5_ESCALATE"
CLOSED = "CLOSED"

MAX_ASK_TURNS = 3
DIFF_SAMPLE_THRESHOLD = 0.90
EDITABLE_FACTS = {"carrier", "province", "summary", "amount", "duration_or_time",
                  "prior_contact_status", "agent_id", "ticket_id", "call_date"}
EDITABLE_STATES = {CONFIRM, CALL, APPEAL}


class FlowError(Exception):
    """A user-facing, friendly refusal (wrong state, missing required choice)."""


def _log(db: Session, case: Case, event: str, payload: dict | None = None, frm=None, to=None):
    db.add(CaseEventLog(case_id=case.case_id, event_type=event, from_state=frm, to_state=to, payload=payload or {}))


def _move(db: Session, case: Case, to: str, event: str, payload: dict | None = None):
    _log(db, case, event, payload, case.current_state, to)
    if to == CLOSED:
        case.evidence = {**case.evidence, "closed_from": case.current_state}
    case.current_state = to


def _require(case: Case, *states: str):
    if case.current_state not in states:
        raise FlowError(f"当前步骤（{case.current_state}）不能执行这个操作")


def _missing(slots: dict) -> list[str]:
    missing = []
    if slots.get("primary_category") in (None, "unknown"):
        missing.append("core_issue")
    if not slots.get("prior_contact_status"):
        missing.append("prior_contact")
    return missing


def create_case(db: Session, user_anon_id: str) -> Case:
    case = Case(user_anon_id=user_anon_id, current_state=INTAKE, turn_count=0, slots={}, evidence={}, generated_texts={})
    db.add(case)
    db.flush()
    _log(db, case, "CASE_CREATED", to=INTAKE)
    return case


def intake_message(db: Session, case: Case, llm: LLMProvider, text: str, quick_reply: str | None) -> dict:
    """Node 1. Returns {"ask": question, ...} while gaps remain, else moves to the confirm card."""
    _require(case, INTAKE)
    slots = dict(case.slots)
    texts = list(case.evidence.get("user_texts", []))
    if quick_reply:
        slots["prior_contact_status"] = quick_reply
    ext = None
    if text.strip():
        texts.append(text.strip())
        ext = llm.extract(text, slots)
        for key, value in ext.model_dump(exclude={"missing_critical_slots", "next_action", "is_emotion_only"}).items():
            if key == "secondary_categories":
                slots[key] = sorted(set(slots.get(key, [])) | set(value))
            elif value not in (None, "unknown"):
                slots[key] = value
        slots["secondary_categories"] = [c for c in slots["secondary_categories"] if c != slots.get("primary_category")]
    case.evidence = {**case.evidence, "user_texts": texts}

    missing = _missing(slots)
    if missing and case.turn_count < MAX_ASK_TURNS:
        case.turn_count += 1
        case.slots = slots
        question = llm.ask(missing, text)
        if ext and ext.is_emotion_only:
            question = rules.templates()["node1"]["empathy"] + question
        _log(db, case, "ASK", {"missing": missing, "turn": case.turn_count})
        return {
            "ask": question,
            "quick_replies": rules.templates()["node1"]["quick_replies"] if "prior_contact" in missing else None,
        }

    if missing:
        db.add(SftFeedbackSample(case_id=case.case_id, sample_type="NLU_ASK_OVERFLOW",
                                 payload={"texts": texts, "slots": slots, "missing": missing}))
    slots["summary"] = llm.summarize(texts, slots)
    case.slots = slots
    _move(db, case, CONFIRM, "INTAKE_DONE", {"missing": missing})
    return {}


def edit_facts(db: Session, case: Case, llm: LLMProvider, changes: dict):
    """Confirm-card edit, or the "点此修改事实信息" entry on nodes 2/3 (which returns to the card)."""
    _require(case, *EDITABLE_STATES)
    changes = {k: v for k, v in changes.items() if k in EDITABLE_FACTS}
    slots = {**case.slots, **changes}
    if "summary" in changes and changes["summary"] != case.slots.get("summary"):
        slots["summary"] = llm.summarize([changes["summary"]], slots)
        ext = llm.extract(changes["summary"], slots)  # silent re-route, never shown to the user
        if ext.primary_category != "unknown":
            slots["primary_category"] = ext.primary_category
            slots["secondary_categories"] = ext.secondary_categories
    case.slots = slots
    case.generated_texts = {k: v for k, v in case.generated_texts.items() if k != "complaint_body"}
    _log(db, case, "FACTS_EDITED", {"fields": sorted(changes)})
    if case.current_state != CONFIRM:
        _move(db, case, CONFIRM, "BACK_TO_CONFIRM")


def confirm(db: Session, case: Case, llm: LLMProvider):
    _require(case, CONFIRM)
    if not case.slots.get("carrier"):
        raise FlowError("请先选择你的运营商（移动 / 联通 / 电信 / 广电）")
    if not case.slots.get("province"):
        raise FlowError("请先选择号码归属的省份")
    if case.slots.get("prior_contact_status") == "ticket_logged":
        _enter_appeal(db, case, llm, "CONFIRMED")
    else:
        _move(db, case, CALL, "CONFIRMED")


def _enter_appeal(db: Session, case: Case, llm: LLMProvider, event: str):
    _move(db, case, APPEAL, event)
    case.generated_texts = {**case.generated_texts, "complaint_body": render.complaint_body(case.slots, llm)}


def call_result(db: Session, case: Case, llm: LLMProvider, resolved: bool,
                agent_id: str | None, ticket_id: str | None, call_date: str | None):
    _require(case, CALL)
    if resolved:
        _move(db, case, CLOSED, "RESOLVED_ON_CALL")
        return
    slots = {**case.slots, "agent_id": agent_id, "ticket_id": ticket_id, "call_date": call_date}
    if ticket_id:
        slots["prior_contact_status"] = "ticket_logged"
    case.slots = slots
    _enter_appeal(db, case, llm, "CALL_UNRESOLVED")


def record_copy(db: Session, case: Case, module: str, text: str):
    _log(db, case, "COPY", {"module": module, "chars": len(text)})
    original = case.generated_texts.get("complaint_body", "")
    if module != "complaint_body" or not original or text == original:
        return
    ratio = SequenceMatcher(None, original, text).ratio()
    case.generated_texts = {**case.generated_texts, "complaint_body_edited": text}
    if ratio < DIFF_SAMPLE_THRESHOLD:
        db.add(SftFeedbackSample(case_id=case.case_id, sample_type="NLG_COMPLAINT_DIFF",
                                 payload={"original": original, "edited": text, "similarity": round(ratio, 3),
                                          "slots": case.slots}))


def submitted(db: Session, case: Case):
    _require(case, APPEAL)
    case.t0_submitted_at = datetime.now(timezone.utc)
    _move(db, case, CALLBACK, "T0_SUBMITTED", {"t0": case.t0_submitted_at.isoformat()})


def callback_result(db: Session, case: Case, resolved: bool):
    _require(case, CALLBACK)
    if resolved:
        _move(db, case, CLOSED, "RESOLVED_BY_CALLBACK")
    else:
        _move(db, case, ESCALATE, "NEGOTIATION_FAILED")


def survey(db: Session, case: Case, result: str, blocker_tag: str | None):
    """3-second closing survey; can be filled at any node (abandoning closes the case)."""
    if db.scalar(select(CaseClosingSurvey).where(CaseClosingSurvey.case_id == case.case_id)):
        raise FlowError("这个案件已经填过问卷了")
    if case.current_state != CLOSED:
        _move(db, case, CLOSED, "CLOSED_BY_SURVEY", {"result": result})
    db.add(CaseClosingSurvey(case_id=case.case_id, closed_at_state=case.evidence.get("closed_from", CLOSED),
                             result=result, blocker_tag=blocker_tag))
    if blocker_tag == "AGENT_OFF_SCRIPT":
        db.add(SftFeedbackSample(case_id=case.case_id, sample_type="RULE_NEW_BRANCH",
                                 payload={"closed_at_state": case.evidence.get("closed_from"), "slots": case.slots,
                                          "user_texts": case.evidence.get("user_texts", [])}))


def scan_timeouts(db: Session, now: datetime | None = None) -> dict:
    """T0+3d reminder flag and T0+15d auto-escalation. Uses the (current_state, t0_submitted_at) index."""
    now = now or datetime.now(timezone.utc)
    cfg = rules.templates()["node4"]
    escalated = reminded = 0
    for case in db.scalars(select(Case).where(
            Case.current_state == CALLBACK,
            Case.t0_submitted_at <= now - timedelta(days=cfg["remind_after_days"]))):
        if case.t0_submitted_at <= now - timedelta(days=cfg["escalate_after_days"]):
            _move(db, case, ESCALATE, "TIMEOUT_ESCALATED", {"days": cfg["escalate_after_days"]})
            escalated += 1
        elif not case.evidence.get("t0_reminded"):
            case.evidence = {**case.evidence, "t0_reminded": True}
            _log(db, case, "T0_REMINDER", {"days": cfg["remind_after_days"]})
            reminded += 1
    return {"escalated": escalated, "reminded": reminded}


def view(case: Case) -> dict:
    s = case.current_state
    card = None
    if s == CONFIRM:
        card = render.confirm_card(case.slots)
    elif s == CALL:
        card = render.node2(case.slots)
    elif s == APPEAL:
        card = render.node3(case.slots, case.generated_texts)
    elif s == CALLBACK:
        card = {**render.node4(case.slots), "t0": case.t0_submitted_at.isoformat(),
                "reminder": bool(case.evidence.get("t0_reminded"))}
    elif s == ESCALATE:
        card = render.node5(case.slots, case.t0_submitted_at)
    return {"case_id": str(case.case_id), "state": s, "turn_count": case.turn_count, "card": card,
            "scaffold": rules.templates()["node1"]["scaffold"] if s == INTAKE else None}
