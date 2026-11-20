"""Spec 1.3: mask PII before anything reaches handlers, the DB or the LLM.

Regex + simple rules. Not a full NER: a name is only caught when introduced by a
cue such as "我叫" / "姓名". Known gap, see README.
"""
import json
import re

PHONE_MASK = "<PHONE_MASKED>"
ID_CARD_MASK = "<ID_CARD_MASKED>"
NAME_MASK = "<NAME_MASKED>"

_ID_CARD_RE = re.compile(r"(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])")
_MOBILE_RE = re.compile(r"(?<!\d)(?:\+?86[- ]?)?1[3-9]\d[- ]?\d{4}[- ]?\d{4}(?!\d)")
_NAME_RE = re.compile(r"(我叫|我是|姓名[:：]?|名字[:：]?)\s*([一-龥]{2,3})(?=[，,。.\s]|$)")
_ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
_ID_CHECK = "10X98765432"
# "我是联通用户" must not be masked as a name
_NOT_NAMES = ("移动", "联通", "电信", "广电", "用户", "客户", "老人", "学生")

# These fields are business identifiers the guardrails must preserve verbatim.
EXEMPT_KEYS = {"agent_id", "ticket_id", "user_anon_id"}


def _valid_id_card(s: str) -> bool:
    total = sum(int(c) * w for c, w in zip(s[:17], _ID_WEIGHTS))
    return _ID_CHECK[total % 11] == s[17].upper()


def mask_text(text: str) -> str:
    text = _ID_CARD_RE.sub(lambda m: ID_CARD_MASK if _valid_id_card(m.group()) else m.group(), text)
    text = _MOBILE_RE.sub(PHONE_MASK, text)

    def _name(m):
        if any(w in m.group(2) for w in _NOT_NAMES):
            return m.group()
        return m.group(1) + NAME_MASK

    return _NAME_RE.sub(_name, text)


def mask_obj(obj, key=None):
    if key in EXEMPT_KEYS:
        return obj
    if isinstance(obj, str):
        return mask_text(obj)
    if isinstance(obj, list):
        return [mask_obj(v) for v in obj]
    if isinstance(obj, dict):
        return {k: mask_obj(v, k) for k, v in obj.items()}
    return obj


class PrivacyMaskingMiddleware:
    """ASGI middleware: rewrites every JSON request body with PII masked."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers") or [])
        if b"application/json" not in headers.get(b"content-type", b""):
            return await self.app(scope, receive, send)

        body = b""
        more = True
        while more:
            msg = await receive()
            body += msg.get("body", b"")
            more = msg.get("more_body", False)
        try:
            body = json.dumps(mask_obj(json.loads(body)), ensure_ascii=False).encode()
        except ValueError:
            pass  # let FastAPI report the malformed body

        scope = dict(scope)
        scope["headers"] = [(k, v) for k, v in scope["headers"] if k != b"content-length"] + [
            (b"content-length", str(len(body)).encode())
        ]
        sent = False

        async def new_receive():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        return await self.app(scope, new_receive, send)
