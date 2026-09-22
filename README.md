# Smart Knowledge Assistant

Bella is a browser-rendered assistant that answers questions and reads the response aloud.

```text
Browser: TalkingHead + Three.js/WebGL + HeadTTS/Kokoro
                              ↑
FastAPI: /api/chat calls Groq and returns answer text
```

The backend sends the current tab's conversation to Groq for a direct LLM response. Authentication, persistent chat storage, streaming, deployment configuration, and observability remain separate integration work.

## Requirements

- Python 3.11+
- A modern desktop browser with WebGL
- A compatible `.glb` avatar: Mixamo-compatible rig plus ARKit and Oculus viseme blendshapes
- Internet access on first load, so HeadTTS can download and cache Bella’s Kokoro voice and model
- A Groq API key exported as `GROQ_API_KEY`

## Run locally

```sh
cd <project-directory>
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt pytest httpx
export GROQ_API_KEY=<your-groq-api-key>
uvicorn app.main:app --reload --port 8000
```

Open <http://localhost:8000>.

## Bella’s avatar

Place an appropriately licensed compatible model at `public/avatars/avatar.glb`. Bella loads that model automatically when the page starts. Review the model’s distribution and commercial-use terms before publishing.

The browser applies a constrained presenter profile suitable for a knowledge assistant:

- head rotation is limited to X ±3°, Y ±5°, and Z ±2°
- eye contact stays on the camera
- blinking occurs every 2.8–5.5 seconds
- idle mouth expressions are disabled; speech uses HeadTTS visemes only

## Bella’s voice

Bella uses the Kokoro `af_bella` voice. After her avatar loads, the browser prepares the voice and attempts to speak Bella’s welcome automatically. If browser autoplay policy requires a user gesture, the status area displays **Start Bella**; selecting it plays the welcome and enables questions.

HeadTTS tries WebGPU first and falls back to WASM when WebGPU is unavailable. The selected model and voice are downloaded and cached by the browser; no API key, TTS account, or server GPU is required.

This initial browser mode currently supports English. For a multi-user deployment, move HeadTTS to a local Node.js CPU/WebGPU service and connect the browser to that service instead.

## Bella’s chat

Bella calls Groq’s GPT-OSS 20B model (`openai/gpt-oss-20b`) directly with low reasoning effort, balancing responsive answers with stronger reasoning. The active browser tab retains up to ten successful user/assistant exchanges. Before the eleventh question, the tab starts a new conversation; refreshing the page or opening another tab also starts fresh.

Keep `GROQ_API_KEY` in your shell or deployment secret manager. Do not put it in source files, browser code, or a committed `.env` file; `.env` is ignored by this project.

## Test

```sh
cd <project-directory>
source .venv/bin/activate
pytest
```

## Chat API

The browser sends the new question and its in-memory conversation history:

```json
{
  "message": "What can you help me with?",
  "history": [
    {"role": "user", "content": "Hello"},
    {"role": "assistant", "content": "Hi, I’m Bella."}
  ]
}
```

The response is:

```json
{"answer": "I can help you explore questions and ideas."}
```
