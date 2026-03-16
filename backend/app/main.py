"""
The Circle — FastAPI Backend (Phase 1)

Entry point: uvicorn app.main:app --reload
"""
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.routers import auth, credits, materials, projects, segments, style_transform

# ── Lifespan ──────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown hooks."""
    # Ensure local upload directory exists
    Path(settings.LOCAL_UPLOAD_DIR).mkdir(parents=True, exist_ok=True)
    yield


# ── App instance ──────────────────────────────────────────────────────────────
app = FastAPI(
    title="The Circle — AI Interior Studio",
    description=(
        "B2B/B2C SaaS: AI-powered interior rendering & material visualisation.\n\n"
        "**Phase 1** — Project management, image upload pipeline, material catalog, credits."
    ),
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

# ── CORS ──────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Static files (local upload fallback) ─────────────────────────────────────
_upload_path = Path(settings.LOCAL_UPLOAD_DIR)
_upload_path.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(_upload_path)), name="uploads")

# ── Routers ───────────────────────────────────────────────────────────────────
API_PREFIX = "/api/v1"

app.include_router(auth.router,      prefix=API_PREFIX)
app.include_router(projects.router,  prefix=API_PREFIX)
app.include_router(materials.router, prefix=API_PREFIX)
app.include_router(credits.router,   prefix=API_PREFIX)
app.include_router(segments.router,         prefix=API_PREFIX)
app.include_router(style_transform.router,  prefix=API_PREFIX)

# ── Unified error handlers ────────────────────────────────────────────────────
@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    """Flatten Pydantic validation errors into a consistent shape."""
    errors = [
        {
            "field": ".".join(str(loc) for loc in err["loc"][1:]) if len(err["loc"]) > 1 else "body",
            "message": err["msg"],
            "type": err["type"],
        }
        for err in exc.errors()
    ]
    return JSONResponse(
        status_code=422,
        content={
            "success": False,
            "message": "요청 데이터가 유효하지 않습니다.",
            "code": "VALIDATION_ERROR",
            "errors": errors,
        },
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """Catch-all for unexpected errors — never leak stack traces in production."""
    if settings.DEBUG:
        import traceback
        detail = traceback.format_exc()
    else:
        detail = "서버 내부 오류가 발생했습니다."

    return JSONResponse(
        status_code=500,
        content={"success": False, "message": detail, "code": "INTERNAL_SERVER_ERROR"},
    )


# ── Health check ──────────────────────────────────────────────────────────────
@app.get("/health", tags=["System"])
def health():
    return {"status": "ok", "version": app.version}
