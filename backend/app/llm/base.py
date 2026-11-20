"""Model-layer contract (spec 2.1 / 4.1). The rule engine never trusts this layer for
law citations, hotlines, deadlines or compensation; guardrails run on its output."""
from typing import Literal, Protocol

from pydantic import BaseModel

Category = Literal["S1", "S2", "S3", "S4", "S5", "S6", "S7", "unknown"]
PriorContact = Literal["none", "verbal_only", "ticket_logged"]


class Extraction(BaseModel):
    """Task A output. Fields left None mean "not found in this message"."""

    carrier: Literal["CMCC", "CUCC", "CTCC", "CBN"] | None = None
    issue: str | None = None  # one line: what went wrong; None = user hasn't said yet
    expectation: str | None = None  # what the user wants / the least they'd accept, in their words
    primary_category: Category = "unknown"  # statistics tag only; no longer drives laws or demands
    secondary_categories: list[Category] = []
    business_or_plan_name: str | None = None
    amount: float | None = None
    duration_or_time: str | None = None
    prior_contact_status: PriorContact | None = None
    ticket_id: str | None = None
    missing_critical_slots: list[Literal["core_issue", "prior_contact", "expectation"]] = []
    next_action: Literal["ask", "confirm"] = "confirm"
    is_emotion_only: bool = False


Feasibility = Literal["高", "中", "低"]


class DemandOption(BaseModel):
    text: str
    feasibility: Feasibility = "中"
    law_ids: list[str] = []
    reason: str = ""
    from_user: bool = False  # the user's own expectation


class Analysis(BaseModel):
    """Node-1 advice: which library laws apply and how feasible each demand is.
    law ids outside the library are dropped by guardrails before anyone sees them."""

    law_ids: list[str] = []
    demands: list[DemandOption] = []


class LLMProvider(Protocol):
    def extract(self, text: str, known: dict) -> Extraction:
        """Task A: slots + S1-S7 primary/secondary from masked user text.
        `known` is the case's current slots so the model can fill only gaps."""

    def ask(self, missing: list[str], text: str) -> str:
        """Task B: one merged plain-language follow-up question, ~30 chars, no legal terms."""

    def summarize(self, texts: list[str], slots: dict) -> str:
        """Objective, plain-language summary of what happened, for the confirm card."""

    def analyze(self, slots: dict, laws: dict) -> Analysis:
        """Pick applicable laws (by id, only from `laws`) and list 2-4 demand options, the user's
        own expectation first, each with feasibility + a one-line reason citing law ids."""

    def rewrite_complaint(self, slots: dict, prior_record: str, demand: str) -> str:
        """Task C: de-emotionalised complaint body. Guardrails run afterwards."""

    def parse_screenshot(self, image: bytes, mime: str) -> dict:
        """VLM/OCR: business name, amount, time, carrier from a bill/SMS screenshot."""
