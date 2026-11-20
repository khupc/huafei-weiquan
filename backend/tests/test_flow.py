from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app import fsm
from app.models import Case, CaseClosingSurvey, CaseEventLog, SftFeedbackSample


def new_case(client):
    return client.post("/api/cases", json={"user_anon_id": "anon"}).json()["case_id"]


def to_confirm(client, text="联通从今年8月开始每个月乱扣彩铃费30元，打过客服没解决，希望全额退钱"):
    cid = new_case(client)
    r = client.post(f"/api/cases/{cid}/messages", json={"text": text}).json()
    return cid, r


def through_advice(client, cid, province="广东", city="深圳", selected=(0,)):
    client.put(f"/api/cases/{cid}/facts", json={"province": province, "city": city})
    r = client.post(f"/api/cases/{cid}/confirm").json()
    assert r["state"] == fsm.ADVICE
    return client.post(f"/api/cases/{cid}/demands", json={"selected": list(selected)}).json()


def test_full_path_via_node2_to_node5(client, db):
    cid, r = to_confirm(client)
    assert r["state"] == fsm.CONFIRM
    card = r["card"]
    assert card["carrier"] == "CUCC" and card["amount"] == 30
    assert card["prior_contact_status"] == "verbal_only"
    assert card["expectation"] == "全额退钱"
    assert "S1" not in str(card)  # internal categories never shown

    # carrier present but province / city missing -> friendly refusal
    r = client.post(f"/api/cases/{cid}/confirm")
    assert r.status_code == 409 and "省份" in r.json()["detail"]
    client.put(f"/api/cases/{cid}/facts", json={"province": "广东"})
    r = client.post(f"/api/cases/{cid}/confirm")
    assert r.status_code == 409 and "城市" in r.json()["detail"]

    client.put(f"/api/cases/{cid}/facts", json={"city": "深圳"})
    r = client.post(f"/api/cases/{cid}/confirm").json()
    assert r["state"] == fsm.ADVICE
    adv = r["card"]
    assert [law["name"] for law in adv["laws"]][0] == "《电信条例》第40条"
    assert adv["demands"][0]["from_user"] and adv["demands"][0]["text"] == "全额退钱"
    assert adv["disclaimer"]

    r = client.post(f"/api/cases/{cid}/demands", json={"selected": [0, 1], "custom": "书面道歉"}).json()
    assert r["state"] == fsm.CALL
    assert r["card"]["transfer"]["hotline"] == "10010"
    labels = [s["label"] for s in r["card"]["script"]]
    assert labels == ["亮明录音", "客观事实", "注入法条", "明确诉求", "立场施压"]
    assert "《电信条例》第40条" in r["card"]["script"][2]["text"]
    assert "全额退钱" in r["card"]["script"][3]["text"] and "书面道歉" in r["card"]["script"][3]["text"]

    r = client.post(f"/api/cases/{cid}/call-result",
                    json={"resolved": False, "agent_id": "A8899", "ticket_id": "GD2024110001", "call_date": "2026-11-19"}).json()
    assert r["state"] == fsm.APPEAL
    guide = {g["label"]: g["value"] for g in r["card"]["form_guide"]}
    assert guide["企业"] == "基础电信运营商 → 中国联通"
    assert guide["所属地区"] == "广东 → 深圳" and guide["投诉编码"] == "GD2024110001"
    mods = {m["key"]: m["text"] for m in r["card"]["modules"]}
    body = mods["complaint_body"]
    assert "A8899" in body and "GD2024110001" in body and "全额退钱" in body
    assert "上述情况涉及《电信条例》第40条" in body and 25 <= len(body) <= 500
    assert mods["ticket_id"] == "GD2024110001"

    # user rewrites the body heavily before copying -> diff sample
    client.post(f"/api/cases/{cid}/copy", json={"module": "complaint_body", "text": "完全不同的一段话，工单GD2024110001。"})
    r = client.post(f"/api/cases/{cid}/submitted").json()
    assert r["state"] == fsm.CALLBACK and r["card"]["general_red_lines"]
    assert "你的底线：全额退钱" in r["card"]["my_lines"]

    r = client.post(f"/api/cases/{cid}/callback-result", json={"resolved": False}).json()
    assert r["state"] == fsm.ESCALATE
    assert "补充说明" in r["card"]["supplement"] and r["card"]["small_claims"] is None

    r = client.post(f"/api/cases/{cid}/survey", json={"result": "PARTIAL_RESOLVED", "blocker_tag": "AGENT_OFF_SCRIPT"}).json()
    assert r["state"] == fsm.CLOSED
    types = set(db.scalars(select(SftFeedbackSample.sample_type)))
    assert types == {"NLG_COMPLAINT_DIFF", "RULE_NEW_BRANCH"}
    assert db.scalar(select(CaseClosingSurvey.closed_at_state)) == fsm.ESCALATE


def test_ticket_logged_skips_node2(client):
    cid = new_case(client)
    r = client.post(f"/api/cases/{cid}/messages", json={"text": "电信宽带拆机押金200元不退，已经投诉过，工单号GD99887766"}).json()
    assert r["state"] == fsm.INTAKE and "怎么解决" in r["ask"]  # expectation asked once
    r = client.post(f"/api/cases/{cid}/messages", json={"text": "退押金"}).json()
    assert r["card"]["prior_contact_status"] == "ticket_logged" and r["card"]["expectation"] == "退押金"
    r = through_advice(client, cid, "四川", "成都")
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
    assert r["state"] == fsm.CONFIRM  # 3 asks used, no infinite loop, expectation not forced
    assert db.scalar(select(SftFeedbackSample.sample_type)) == "NLU_ASK_OVERFLOW"


def test_missing_carrier_blocks_confirm(client):
    cid, _ = to_confirm(client, "每个月乱扣费20元，还没打过客服，希望退钱")
    r = client.post(f"/api/cases/{cid}/confirm")
    assert r.status_code == 409 and "运营商" in r.json()["detail"]


def test_edit_from_node2_returns_to_confirm_and_reanalyzes(client):
    cid, _ = to_confirm(client)
    through_advice(client, cid)
    r = client.put(f"/api/cases/{cid}/facts", json={"summary": "宽带拆机后押金一直不退"}).json()
    assert r["state"] == fsm.CONFIRM
    r = client.post(f"/api/cases/{cid}/confirm").json()
    assert r["state"] == fsm.ADVICE
    assert any("押金" in d["text"] for d in r["card"]["demands"])  # fresh advice for the new facts


def test_choose_demands_needs_one(client):
    cid, _ = to_confirm(client)
    client.put(f"/api/cases/{cid}/facts", json={"province": "广东", "city": "深圳"})
    client.post(f"/api/cases/{cid}/confirm")
    r = client.post(f"/api/cases/{cid}/demands", json={"selected": [], "custom": "  "})
    assert r.status_code == 409 and "至少选一个" in r.json()["detail"]
    r = client.post(f"/api/cases/{cid}/demands", json={"selected": [], "custom": "恢复原号码"}).json()
    assert r["state"] == fsm.CALL and "恢复原号码" in r["card"]["script"][-2]["text"]
    assert all(s["label"] != "注入法条" for s in r["card"]["script"])  # no chosen laws -> no law line


def test_number_cancelled_is_understood_without_a_category(client):
    """Regression for the first test round: the keyword stub cannot classify it, so it asks."""
    cid = new_case(client)
    r = client.post(f"/api/cases/{cid}/messages", json={"text": "我的移动号码被注销了，打过客服没解决"}).json()
    assert r["state"] == fsm.INTAKE


def test_timeout_scan(client, db):
    cid, _ = to_confirm(client, "移动停机了，打过客服没解决，欠费1200元，希望恢复通信")
    through_advice(client, cid, "北京", "北京")
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
    through_advice(client, cid)
    r = client.post(f"/api/cases/{cid}/call-result", json={"resolved": True}).json()
    assert r["state"] == fsm.CLOSED
    assert client.post(f"/api/cases/{cid}/survey", json={"result": "FULL_RESOLVED"}).status_code == 200
    assert client.post(f"/api/cases/{cid}/survey", json={"result": "FULL_RESOLVED"}).status_code == 409
