"""Spec 4.2: post-generation hard guardrails for the complaint body."""
import re

from . import rules

# 《某法》第X条 / 《某规定》第X款 etc. Law citations are only allowed via the rule library.
_LAW_RE = re.compile(r"(根据|依据|按照)?《[^》]{1,30}》(第[0-9一二三四五六七八九十百零]+[条款项])+(的?(相关)?规定)?[，,]?")
# 赔偿3倍 / 三倍赔偿 / 退一赔三 / 双倍赔偿
_COMP_RE = re.compile(
    r"[，,]?[^，,。]{0,8}(赔偿?[0-9一二三四五六七八九十两双]+倍|[0-9一二三四五六七八九十两双]+倍(的)?赔偿|退一赔[0-9一二三四五六七八九十])[^，,。]{0,8}"
)


def strip_fabricated_law(text: str) -> str:
    text = _LAW_RE.sub("", text)
    return _COMP_RE.sub("", text)


def strip_emotion(text: str) -> str:
    text = re.sub(r"[!！]+", "。", text)
    text = re.sub(r"[?？]{2,}", "？", text)
    for w in rules.templates()["guardrails"]["emotional_words"]:
        text = text.replace(w, "")
    text = re.sub(r"。{2,}", "。", text)
    return text.strip()


def _amount_str(amount) -> str | None:
    if amount in (None, ""):
        return None
    a = float(amount)
    return f"{a:g}"


def restore_and_truncate(text: str, slots: dict, max_chars: int) -> str:
    """Re-append ticket/agent id or amount if the model dropped them, then cut to max_chars.

    The restored suffix is kept intact; the model text is truncated to make room.
    """
    missing = []
    if slots.get("ticket_id") and slots["ticket_id"] not in text:
        missing.append(f"工单编号{slots['ticket_id']}")
    if slots.get("agent_id") and slots["agent_id"] not in text:
        missing.append(f"客服工号{slots['agent_id']}")
    amt = _amount_str(slots.get("amount"))
    if amt and amt not in text:
        missing.append(f"涉及金额{amt}元")
    suffix = f"（{'，'.join(missing)}）" if missing else ""

    room = max_chars - len(suffix)
    if len(text) > room:
        cut = text[:room]
        # prefer ending on a full sentence
        last = max(cut.rfind("。"), cut.rfind("；"))
        text = cut[: last + 1] if last >= room * 0.6 else cut
    return text + suffix


def apply(text: str, slots: dict, reserve: int = 0) -> str:
    """`reserve` = room kept for the library law line the renderer adds afterwards."""
    max_chars = rules.templates()["node3"]["body_max_chars"] - reserve
    text = strip_emotion(strip_fabricated_law(text))
    return restore_and_truncate(text, slots, max_chars)


def check_analysis(analysis, laws: dict) -> dict:
    """Model advice -> what the page may show: law ids only from the library, no law text or
    compensation multiples in free text, short reasons, at most 4 demands."""
    limit = rules.templates()["node1"]["advice"]["reason_max_chars"]

    def clean(t: str) -> str:
        return strip_emotion(strip_fabricated_law(t or "")).strip()

    law_ids = list(dict.fromkeys(i for i in analysis.law_ids if i in laws))
    demands = []
    for d in analysis.demands:
        text = clean(d.text)
        if not text:
            continue
        reason = clean(d.reason)
        demands.append({"text": text, "feasibility": d.feasibility, "from_user": d.from_user,
                        "law_ids": [i for i in dict.fromkeys(d.law_ids) if i in laws],
                        "reason": reason[:limit] + ("…" if len(reason) > limit else "")})
    demands.sort(key=lambda d: not d["from_user"])  # the user's own expectation first
    return {"law_ids": law_ids, "demands": demands[:4]}
