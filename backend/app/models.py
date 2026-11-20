"""Spec 5.1: the four core tables."""
import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def now():
    return datetime.now(timezone.utc)


class Case(Base):
    __tablename__ = "cases"

    case_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_anon_id: Mapped[str] = mapped_column(String(64), index=True)
    current_state: Mapped[str] = mapped_column(String(32))
    turn_count: Mapped[int] = mapped_column(Integer, default=0)
    slots: Mapped[dict] = mapped_column(JSONB, default=dict)
    evidence: Mapped[dict] = mapped_column(JSONB, default=dict)
    generated_texts: Mapped[dict] = mapped_column(JSONB, default=dict)
    t0_submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)

    __table_args__ = (Index("ix_cases_state_t0", "current_state", "t0_submitted_at"),)


class CaseEventLog(Base):
    __tablename__ = "case_event_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    case_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("cases.case_id"), index=True)
    event_type: Mapped[str] = mapped_column(String(48))
    from_state: Mapped[str | None] = mapped_column(String(32))
    to_state: Mapped[str | None] = mapped_column(String(32))
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class SftFeedbackSample(Base):
    __tablename__ = "sft_feedback_samples"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    case_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("cases.case_id"), index=True)
    sample_type: Mapped[str] = mapped_column(String(32))  # NLU_ASK_OVERFLOW / NLG_COMPLAINT_DIFF / RULE_NEW_BRANCH
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class CaseClosingSurvey(Base):
    __tablename__ = "case_closing_surveys"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    case_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("cases.case_id"), unique=True)
    closed_at_state: Mapped[str] = mapped_column(String(32))
    result: Mapped[str] = mapped_column(String(24))  # FULL_RESOLVED / PARTIAL_RESOLVED / ABANDONED
    blocker_tag: Mapped[str | None] = mapped_column(String(24))  # UNCLEAR_GUIDE / AGENT_OFF_SCRIPT / FORM_HARD / TOO_TIRED
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
