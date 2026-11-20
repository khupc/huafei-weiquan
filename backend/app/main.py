import asyncio
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy.orm import Session

from . import fsm
from .db import Base, SessionLocal, engine, get_session
from .llm import get_provider
from .models import Case
from .privacy import PrivacyMaskingMiddleware

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
llm = get_provider()


async def _scheduler():
    interval = int(os.getenv("JOB_INTERVAL_SECONDS", "3600"))
    while True:
        with SessionLocal() as db:
            fsm.scan_timeouts(db)
            db.commit()
        await asyncio.sleep(interval)


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(engine)
    task = asyncio.create_task(_scheduler()) if os.getenv("RUN_SCHEDULER", "1") == "1" else None
    yield
    if task:
        task.cancel()


app = FastAPI(title="话费维权指引 MVP", lifespan=lifespan)
app.add_middleware(PrivacyMaskingMiddleware)


@app.exception_handler(fsm.FlowError)
async def flow_error(_, exc: fsm.FlowError):
    return JSONResponse(status_code=409, content={"detail": str(exc)})


def load_case(case_id: uuid.UUID, db: Session = Depends(get_session)) -> Case:
    case = db.get(Case, case_id, with_for_update=True)
    if not case:
        raise HTTPException(404, "案件不存在")
    return case


def done(db: Session, case: Case, **extra) -> dict:
    db.commit()
    return {**fsm.view(case), **extra}


class NewCase(BaseModel):
    user_anon_id: str


class Message(BaseModel):
    text: str = ""
    quick_reply: Literal["none", "verbal_only", "ticket_logged"] | None = None


class Facts(BaseModel):
    carrier: Literal["CMCC", "CUCC", "CTCC", "CBN"] | None = None
    province: str | None = None
    summary: str | None = None
    amount: float | None = None
    duration_or_time: str | None = None
    prior_contact_status: Literal["none", "verbal_only", "ticket_logged"] | None = None
    agent_id: str | None = None
    ticket_id: str | None = None
    call_date: str | None = None


class CallResult(BaseModel):
    resolved: bool
    agent_id: str | None = None
    ticket_id: str | None = None
    call_date: str | None = None


class Copy(BaseModel):
    module: Literal["company", "prior_record", "complaint_body", "demands", "supplement"]
    text: str


class Resolved(BaseModel):
    resolved: bool


class Survey(BaseModel):
    result: Literal["FULL_RESOLVED", "PARTIAL_RESOLVED", "ABANDONED"]
    blocker_tag: Literal["UNCLEAR_GUIDE", "AGENT_OFF_SCRIPT", "FORM_HARD", "TOO_TIRED"] | None = None


@app.post("/api/cases")
def create_case(body: NewCase, db: Session = Depends(get_session)):
    case = fsm.create_case(db, body.user_anon_id)
    return done(db, case)


@app.get("/api/cases/{case_id}")
def get_case(case: Case = Depends(load_case), db: Session = Depends(get_session)):
    return done(db, case)


@app.post("/api/cases/{case_id}/messages")
def post_message(body: Message, case: Case = Depends(load_case), db: Session = Depends(get_session)):
    return done(db, case, **fsm.intake_message(db, case, llm, body.text, body.quick_reply))


@app.post("/api/cases/{case_id}/screenshot")
async def screenshot(file: UploadFile = File(...), case: Case = Depends(load_case), db: Session = Depends(get_session)):
    """The image itself is never stored (it may show phone numbers); only extracted fields are kept."""
    fsm._require(case, fsm.INTAKE, fsm.CONFIRM)
    fields = llm.parse_screenshot(await file.read(), file.content_type or "")
    if fields:
        case.evidence = {**case.evidence, "screenshots": case.evidence.get("screenshots", []) + [fields]}
        case.slots = {**case.slots, **{k: v for k, v in fields.items() if v and not case.slots.get(k)}}
    return done(db, case, screenshot_fields=fields)


@app.put("/api/cases/{case_id}/facts")
def edit_facts(body: Facts, case: Case = Depends(load_case), db: Session = Depends(get_session)):
    fsm.edit_facts(db, case, llm, body.model_dump(exclude_unset=True))
    return done(db, case)


@app.post("/api/cases/{case_id}/confirm")
def confirm(case: Case = Depends(load_case), db: Session = Depends(get_session)):
    fsm.confirm(db, case, llm)
    return done(db, case)


@app.post("/api/cases/{case_id}/call-result")
def call_result(body: CallResult, case: Case = Depends(load_case), db: Session = Depends(get_session)):
    fsm.call_result(db, case, llm, body.resolved, body.agent_id, body.ticket_id, body.call_date)
    return done(db, case)


@app.post("/api/cases/{case_id}/copy")
def copy(body: Copy, case: Case = Depends(load_case), db: Session = Depends(get_session)):
    fsm.record_copy(db, case, body.module, body.text)
    return done(db, case)


@app.post("/api/cases/{case_id}/submitted")
def submitted(case: Case = Depends(load_case), db: Session = Depends(get_session)):
    fsm.submitted(db, case)
    return done(db, case)


@app.post("/api/cases/{case_id}/callback-result")
def callback_result(body: Resolved, case: Case = Depends(load_case), db: Session = Depends(get_session)):
    fsm.callback_result(db, case, body.resolved)
    return done(db, case)


@app.post("/api/cases/{case_id}/survey")
def survey(body: Survey, case: Case = Depends(load_case), db: Session = Depends(get_session)):
    fsm.survey(db, case, body.result, body.blocker_tag)
    return done(db, case)


if FRONTEND.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND), name="static")

    @app.get("/")
    def index():
        return FileResponse(FRONTEND / "index.html")
