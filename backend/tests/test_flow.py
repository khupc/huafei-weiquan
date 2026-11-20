from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app import fsm
from app.models import Case, CaseClosingSurvey, CaseEventLog, SftFeedbackSample


def new_case(client):
    return client.post("/api/cases", json={"user_anon_id": "anon"}).json()["case_id"]


def to_confirm(client, text="联通从今年8月开始每个月乱扣彩铃费30元，打过客服没解决"):
    cid = new_case(client)
    r = client.post(f"/api/cases/{cid}/messages", json={"text": text}).json()
    return cid, r


def test_full_path_via_node2_to_node5(client, db):
    cid, r = to_confirm(client)
    assert r["state"] == fsm.CONFIRM
    card = r["card"]
    assert card["carrier"] == "CUCC" and card["amount"] == 30
    assert card["prior_contact_status"] == "verbal_only"
    assert "S1" not in str(card)  # internal categories never shown

    # carrier present but province missing -> friendly refusal
    r = client.post(f"/api/cases/{cid}/confirm")
    assert r.status_code == 409 and "省份" in r.json()["detail"]

    client.put(f"/api/cases/{cid}/facts", json={"province": "广东"})
    r = client.post(f"/api/cases/{cid}/confirm").json()
    assert r["state"] == fsm.CALL
    assert r["card"]["transfer"]["hotline"] == "10010"
    labels = [s["label"] for s in r["card"]["script"]]
    assert labels == ["亮明录音", "客观事实", "注入法条", "明确诉求", "立场施压"]
    assert "《电信条例》第40条" in r["card"]["script"][2]["text"]

    r = client.post(f"/api/cases/{cid}/call-result",
                    json={"resolved": False, "agent_id": "A8899", "ticket_id": "GD2024110001", "call_date": "2026-11-19"}).json()
    assert r["state"] == fsm.APPEAL
    mods = {m["key"]: m["text"] for m in r["card"]["modules"]}
    assert mods["company"] == "中国联合网络通信有限公司广东分公司"
    assert "A8899" in mods["prior_record"] and "GD2024110001" in mods["prior_record"]
    assert "GD2024110001" in mods["complaint_body"] and len(mods["complaint_body"]) <= 280

    # user rewrites the body heavily before copying -> diff sample
    client.post(f"/api/cases/{cid}/copy", json={"module": "complaint_body", "text": "完全不同的一段话，工单GD2024110001。"})
    r = client.post(f"/api/cases/{cid}/submitted").json()
    assert r["state"] == fsm.CALLBACK and r["card"]["general_red_lines"]

    r = client.post(f"/api/cases/{cid}/callback-result", json={"resolved": False}).json()
    assert r["state"] == fsm.ESCALATE
    assert "补充说明" in r["card"]["supplement"] and r["card"]["small_claims"] is None

    r = client.post(f"/api/cases/{cid}/survey", json={"result": "PARTIAL_RESOLVED", "blocker_tag": "AGENT_OFF_SCRIPT"}).json()
    assert r["state"] == fsm.CLOSED
    types = set(db.scalars(select(SftFeedbackSample.sample_type)))
    assert types == {"NLG_COMPLAINT_DIFF", "RULE_NEW_BRANCH"}
    assert db.scalar(select(CaseClosingSurvey.closed_at_state)) == fsm.ESCALATE


def test_ticket_logged_skips_node2(client):
    cid, r = to_confirm(client, "电信宽带拆机押金200元不退，已经投诉过，工单号GD99887766")
    assert r["card"]["prior_contact_status"] == "ticket_logged"
    client.put(f"/api/cases/{cid}/facts", json={"province": "四川"})
    r = client.post(f"/api/cases/{cid}/confirm").json()
    assert r["state"] == fsm.APPEAL


def test_ask_then_quick_reply_and_cap_at_three(client, db):
    cid = new_case(client)
    r = client.post(f"/api/cases/{cid}/messages", json={"text": "联通太坑了"}).json()
    assert r["state"] == fsm.INTAKE and r["ask"].startswith("遇到这种事")
    assert r["quick_replies"]
    r = client.post(f"/api/cases/{cid}/messages", json={"text": "", "quick_reply": "none"}).json()
    assert r["state"] == fsm.INTAKE  # still no core issue
    r = client.post(f"/api/cases/{cid}/messages", json={"text": "不知道"}).json()
    assert r["state"] == fsm.INTAKE
    r = client.post(f"/api/cases/{cid}/messages", json={"text": "反正很烦"}).json()
    assert r["state"] == fsm.CONFIRM  # 3 asks used, no infinite loop
    assert db.scalar(select(SftFeedbackSample.sample_type)) == "NLU_ASK_OVERFLOW"


def test_missing_carrier_blocks_confirm(client):
    cid, _ = to_confirm(client, "每个月乱扣费20元，还没打过客服")
    r = client.post(f"/api/cases/{cid}/confirm")
    assert r.status_code == 409 and "运营商" in r.json()["detail"]


def test_edit_from_node2_returns_to_confirm_and_reroutes(client):
    cid, _ = to_confirm(client)
    client.put(f"/api/cases/{cid}/facts", json={"province": "广东"})
    client.post(f"/api/cases/{cid}/confirm")
    r = client.put(f"/api/cases/{cid}/facts", json={"summary": "宽带拆机后押金一直不退"}).json()
    assert r["state"] == fsm.CONFIRM
    r = client.post(f"/api/cases/{cid}/confirm").json()
    assert "押金" in r["card"]["script"][3]["text"]  # demand now comes from S6


def test_timeout_scan(client, db):
    cid, _ = to_confirm(client, "移动停机了，打过客服没解决，欠费1200元")
    client.put(f"/api/cases/{cid}/facts", json={"province": "北京"})
    client.post(f"/api/cases/{cid}/confirm")
    client.post(f"/api/cases/{cid}/call-result", json={"resolved": False})
    client.post(f"/api/cases/{cid}/submitted")

    case = db.get(Case, cid)
    case.t0_submitted_at = datetime.now(timezone.utc) - timedelta(days=4)
    db.commit()
    assert fsm.scan_timeouts(db) == {"escalated": 0, "reminded": 1}
    assert fsm.scan_timeouts(db) == {"escalated": 0, "reminded": 0}
    db.commit()

    case.t0_submitted_at = datetime.now(timezone.utc) - timedelta(days=16)
    db.commit()
    assert fsm.scan_timeouts(db)["escalated"] == 1
    db.commit()
    r = client.get(f"/api/cases/{cid}").json()
    assert r["state"] == fsm.ESCALATE and r["card"]["small_claims"]
    assert db.scalar(select(CaseEventLog).where(CaseEventLog.event_type == "TIMEOUT_ESCALATED"))


def test_resolved_on_call_then_survey(client):
    cid, _ = to_confirm(client)
    client.put(f"/api/cases/{cid}/facts", json={"province": "广东"})
    client.post(f"/api/cases/{cid}/confirm")
    r = client.post(f"/api/cases/{cid}/call-result", json={"resolved": True}).json()
    assert r["state"] == fsm.CLOSED
    assert client.post(f"/api/cases/{cid}/survey", json={"result": "FULL_RESOLVED"}).status_code == 200
    assert client.post(f"/api/cases/{cid}/survey", json={"result": "FULL_RESOLVED"}).status_code == 409
