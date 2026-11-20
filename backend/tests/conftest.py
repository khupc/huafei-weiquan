import os

os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://huafei:huafei@localhost:5432/huafei_test")
os.environ["RUN_SCHEDULER"] = "0"

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db import Base, SessionLocal, engine
from app.main import app


@pytest.fixture(autouse=True)
def clean_db():
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE cases, case_event_logs, sft_feedback_samples, case_closing_surveys RESTART IDENTITY CASCADE"))
    yield


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def db():
    with SessionLocal() as s:
        yield s
