import os
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from groq import AsyncGroq

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DIR = PROJECT_ROOT / "public"
GROQ_MODEL = "openai/gpt-oss-20b"
BELLA_SYSTEM_MESSAGE = (
    "You are Bella, the Smart Knowledge Assistant. Answer questions clearly, "
    "warmly, and accurately. Do not invent citations or capabilities. If you "
    "are uncertain, say so. Keep answers concise to a maximum of 3 sentences unless the user asks for detail."
)

groq_client: Optional[AsyncGroq] = None

app = FastAPI(title="Smart Knowledge Assistant")
app.mount("/static", StaticFiles(directory=PUBLIC_DIR), name="static")


class ConversationMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4_000)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2_000)
    history: list[ConversationMessage] = Field(default_factory=list, max_length=20)


class ChatResponse(BaseModel):
    answer: str


def get_groq_client() -> AsyncGroq:
    """Return the process-local Groq client without exposing its API key."""
    global groq_client

    if not os.environ.get("GROQ_API_KEY"):
        raise HTTPException(
            status_code=503,
            detail="Bella is not configured yet. Set GROQ_API_KEY and try again.",
        )
    if groq_client is None:
        groq_client = AsyncGroq()
    return groq_client


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(PUBLIC_DIR / "index.html")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    """Generate a direct LLM response using only the current tab's context."""
    question = request.message.strip()
    if not question:
        raise HTTPException(status_code=422, detail="Message must not be blank.")

    messages = [
        {"role": "system", "content": BELLA_SYSTEM_MESSAGE},
        *(message.model_dump() for message in request.history),
        {"role": "user", "content": question},
    ]
    try:
        completion = await get_groq_client().chat.completions.create(
            model=GROQ_MODEL,
            reasoning_effort="low",
            messages=messages,
        )
        answer = completion.choices[0].message.content
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=502,
            detail="Bella is temporarily unavailable. Please try again.",
        ) from None

    if not answer:
        raise HTTPException(
            status_code=502,
            detail="Bella is temporarily unavailable. Please try again.",
        )
    return ChatResponse(answer=answer)
