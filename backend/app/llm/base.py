"""Model-layer contract (spec 2.1 / 4.1). The rule engine never trusts this layer for
law citations, hotlines, deadlines or compensation; guardrails run on its output."""
from typing import Literal, Protocol

from pydantic import BaseModel

Category = Literal["S1", "S2", "S3", "S4", "S5", "S6", "S7", "unknown"]
PriorContact = Literal["none", "verbal_only", "ticket_logged"]


class Extraction(BaseModel):
    """Task A output. Fields left None mean "not found in this message"."""

    carrier: Literal["CMCC", "CUCC", "CTCC", "CBN"] | None = None
    primary_category: Category = "unknown"
    secondary_categories: list[Category] = []
    business_or_plan_name: str | None = None
    amount: float | None = None
    duration_or_time: str | None = None
    prior_contact_status: PriorContact | None = None
    ticket_id: str | None = None
    missing_critical_slots: list[Literal["core_issue", "prior_contact"]] = []
    next_action: Literal["ask", "confirm"] = "confirm"
    is_emotion_only: bool = False


class LLMProvider(Protocol):
    def extract(self, text: str, known: dict) -> Extraction:
        """Task A: slots + S1-S7 primary/secondary from masked user text.
        `known` is the case's current slots so the model can fill only gaps."""

    def ask(self, missing: list[str], text: str) -> str:
        """Task B: one merged plain-language follow-up question, ~30 chars, no legal terms."""

    def summarize(self, texts: list[str], slots: dict) -> str:
        """Objective, plain-language summary of what happened, for the confirm card."""

    def rewrite_complaint(self, slots: dict, prior_record: str, demand: str) -> str:
        """Task C: de-emotionalised complaint body. Guardrails run afterwards."""

    def parse_screenshot(self, image: bytes, mime: str) -> dict:
        """VLM/OCR: business name, amount, time, carrier from a bill/SMS screenshot."""
