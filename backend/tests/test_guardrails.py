from app import guardrails, rules
from app.llm import Analysis, DemandOption


def test_strips_fabricated_law_and_compensation():
    out = guardrails.apply("根据《电信法》第12条的规定，运营商违规扣费，应赔偿3倍。请退款！", {})
    assert "《" not in out and "倍" not in out
    assert "！" not in out and "请退款" in out


def test_restores_dropped_ids_and_amount():
    out = guardrails.apply("运营商乱扣费，请退款。", {"ticket_id": "GD2024001", "agent_id": "A123", "amount": 30.0})
    assert "GD2024001" in out and "A123" in out and "30" in out


def test_truncates_to_500_and_keeps_restored_suffix():
    out = guardrails.apply("这是一段很长的事实陈述。" * 60, {"ticket_id": "GD2024001"})
    assert len(out) <= 500
    assert out.endswith("（工单编号GD2024001）")


def test_reserve_leaves_room_for_law_line():
    out = guardrails.apply("这是一段很长的事实陈述。" * 60, {}, reserve=40)
    assert len(out) <= 460


def test_check_analysis_drops_unknown_laws_and_cleans_text():
    a = Analysis(law_ids=["telecom_reg_40", "made_up_law"], demands=[
        DemandOption(text="退款，并赔偿3倍", law_ids=["made_up_law", "consumer_9"],
                     reason="根据《电信法》第99条，运营商必须退款，这个理由写得特别特别长，长到超过了四十个字的上限很多很多"),
        DemandOption(text="恢复号码", from_user=True, feasibility="低"),
        DemandOption(text="  "),
    ])
    out = guardrails.check_analysis(a, rules.laws())
    assert out["law_ids"] == ["telecom_reg_40"]
    assert [d["text"] for d in out["demands"]] == ["恢复号码", "退款"]  # user's own first, empty dropped
    first_model = out["demands"][1]
    assert first_model["law_ids"] == ["consumer_9"]
    assert "《" not in first_model["reason"] and len(first_model["reason"]) <= 41
