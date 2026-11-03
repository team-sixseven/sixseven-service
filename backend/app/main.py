import sqlite3
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from .database import check_database, initialize_database


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.database_path = initialize_database()
    yield


app = FastAPI(
    title="SixSeven Service API",
    version="0.1.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    redoc_url=None,
    lifespan=lifespan,
)


class HealthStatus(BaseModel):
    status: Literal["ok"]
    database: Literal["sqlite"]


class ModelStatus(BaseModel):
    status: Literal["not_connected"]
    model_id: str | None = None


@app.get("/api/health", response_model=HealthStatus, tags=["status"])
def health(request: Request) -> HealthStatus:
    try:
        check_database(request.app.state.database_path)
    except sqlite3.Error as error:
        raise HTTPException(status_code=503, detail="Database unavailable") from error
    return HealthStatus(status="ok", database="sqlite")


@app.get("/api/model", response_model=ModelStatus, tags=["status"])
def model_status() -> ModelStatus:
    return ModelStatus(status="not_connected")
