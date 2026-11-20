from app import guardrails


def test_strips_fabricated_law_and_compensation():
    out = guardrails.apply("根据《电信法》第12条的规定，运营商违规扣费，应赔偿3倍。请退款！", {})
    assert "《" not in out and "倍" not in out
    assert "！" not in out and "请退款" in out


def test_restores_dropped_ids_and_amount():
    out = guardrails.apply("运营商乱扣费，请退款。", {"ticket_id": "GD2024001", "agent_id": "A123", "amount": 30.0})
    assert "GD2024001" in out and "A123" in out and "30" in out


def test_truncates_to_280_and_keeps_restored_suffix():
    out = guardrails.apply("这是一段很长的事实陈述。" * 60, {"ticket_id": "GD2024001"})
    assert len(out) <= 280
    assert out.endswith("（工单编号GD2024001）")
