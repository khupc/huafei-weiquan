from app.privacy import mask_obj, mask_text


def test_masks_mobile_and_valid_id_card():
    out = mask_text("我手机13812345678，身份证11010519491231002X")
    assert "<PHONE_MASKED>" in out and "<ID_CARD_MASKED>" in out
    assert "13812345678" not in out


def test_keeps_invalid_id_like_numbers_and_hotlines():
    # 18 digits with a wrong checksum (e.g. a ticket number) is not masked
    assert mask_text("单号123456789012345678") == "单号123456789012345678"
    assert mask_text("打了10086") == "打了10086"


def test_name_cue_but_not_carrier_words():
    assert mask_text("我叫王小明，联通扣费") == "我叫<NAME_MASKED>，联通扣费"
    assert mask_text("我是联通用户，") == "我是联通用户，"


def test_exempt_business_ids():
    out = mask_obj({"ticket_id": "13812345678", "text": "13812345678"})
    assert out == {"ticket_id": "13812345678", "text": "<PHONE_MASKED>"}


def test_middleware_masks_before_storage(client, db):
    from app.models import Case
    cid = client.post("/api/cases", json={"user_anon_id": "u1"}).json()["case_id"]
    client.post(f"/api/cases/{cid}/messages", json={"text": "我的号13812345678被联通乱扣费"})
    stored = db.get(Case, cid).evidence["user_texts"][0]
    assert "13812345678" not in stored and "<PHONE_MASKED>" in stored
