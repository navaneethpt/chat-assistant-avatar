import app.main as main
from fastapi.testclient import TestClient

from app.main import PUBLIC_DIR, app

client = TestClient(app)


def test_health_is_available():
    assert client.get("/health").json() == {"status": "ok"}


def test_api_uses_production_title():
    assert client.get("/openapi.json").json()["info"]["title"] == "Smart Knowledge Assistant"


class FakeCompletion:
    class Choice:
        class Message:
            content = "A direct answer from Bella."

        message = Message()

    choices = [Choice()]


class FakeCompletions:
    def __init__(self):
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return FakeCompletion()


class FakeGroqClient:
    def __init__(self):
        self.completions = FakeCompletions()
        self.chat = type("Chat", (), {"completions": self.completions})()


def test_chat_calls_groq_with_bella_context(monkeypatch):
    fake_client = FakeGroqClient()
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    monkeypatch.setattr(main, "groq_client", fake_client)

    response = client.post(
        "/api/chat",
        json={
            "message": "What did I ask?",
            "history": [
                {"role": "user", "content": "Remember this detail."},
                {"role": "assistant", "content": "I will remember it."},
            ],
        },
    )

    assert response.status_code == 200
    assert response.json() == {"answer": "A direct answer from Bella."}
    assert fake_client.completions.calls == [
        {
            "model": "openai/gpt-oss-20b",
            "reasoning_effort": "low",
            "messages": [
                {"role": "system", "content": main.BELLA_SYSTEM_MESSAGE},
                {"role": "user", "content": "Remember this detail."},
                {"role": "assistant", "content": "I will remember it."},
                {"role": "user", "content": "What did I ask?"},
            ],
        },
    ]


def test_chat_reports_missing_groq_key(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.setattr(main, "groq_client", None)

    response = client.post("/api/chat", json={"message": "Hello"})

    assert response.status_code == 503
    assert "GROQ_API_KEY" in response.json()["detail"]


def test_chat_hides_groq_failures_and_logs_the_cause(monkeypatch, caplog):
    class FailingCompletions:
        async def create(self, **kwargs):
            raise RuntimeError("provider details must stay private")

    fake_client = type(
        "FakeGroqClient",
        (), {"chat": type("Chat", (), {"completions": FailingCompletions()})()},
    )()
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    monkeypatch.setattr(main, "groq_client", fake_client)

    response = client.post("/api/chat", json={"message": "Hello"})

    assert response.status_code == 502
    assert response.json()["detail"] == "Bella is temporarily unavailable. Please try again."
    assert (
        "Groq chat completion failed: RuntimeError: provider details must stay private"
        in caplog.text
    )


def test_chat_rejects_blank_messages():
    assert client.post("/api/chat", json={"message": ""}).status_code == 422


def test_home_page_uses_bella_copy_without_configuration_or_sources():
    page = client.get("/").text

    assert "<title>Smart Knowledge Assistant</title>" in page
    assert "<h1>Smart Knowledge Assistant</h1>" in page
    assert "Ask Bella a question. She’ll answer it and read it aloud." in page
    assert "Bella’s answer" in page
    assert 'aria-label="Bella, Smart Knowledge Assistant"' in page
    assert 'id="status-action"' in page
    assert 'id="stop-button"' in page
    assert page.index('id="ask-button"') < page.index('id="stop-button"')
    assert 'id="avatar-url"' not in page
    assert 'id="camera-pitch"' not in page
    assert 'id="voice"' not in page
    assert 'id="prepare-voice"' not in page
    assert "Sources" not in page
    assert 'id="sources"' not in page


def test_frontend_autoloads_bella_with_the_default_voice():
    script = (PUBLIC_DIR / "app.js").read_text()

    assert 'const AVATAR_URL = "/static/avatars/avatar.glb";' in script
    assert 'const BELLA_VOICE = "af_bella";' in script
    assert (
        'const WELCOME_MESSAGE = "Hi, I am Bella. I am here to help you with your '
        'questions. Ask me anything and I can answer it to the best of my ability.";'
    ) in script
    assert "answerNode.textContent = WELCOME_MESSAGE;" in script
    assert "await startWelcome();" in script
    assert 'showStatusAction(userInitiated ? "Retry" : "Start Bella", retryWelcome);' in script
    assert 'showStatusAction("Retry", loadAvatar);' in script
    assert "const MAX_CONVERSATION_EXCHANGES = 10;" in script
    assert "conversationHistory = [];" in script
    assert 'setStatus("Starting a new conversation…", "busy");' in script
    assert "body: JSON.stringify({ message, history: conversationHistory })," in script
    assert "conversationHistory.push(" in script
    assert "renderSources" not in script
    assert 'const stopButton = document.querySelector("#stop-button");' in script
    assert "setStopButtonVisible(true);" in script
    assert "setStopButtonVisible(false);" in script
    assert 'stopButton.addEventListener("click", stopCurrentSpeech);' in script
    assert "head?.stopSpeaking();" in script
    assert "session.cancelled = true;" in script
    assert "askButton.disabled = !canAskQuestion();" in script
    assert "loadAvatar();" in script
