import { TalkingHead } from "talkinghead";
import { HeadTTS } from "https://cdn.jsdelivr.net/npm/@met4citizen/headtts@1.3/+esm";

const avatarNode = document.querySelector("#avatar");
const avatarMessage = document.querySelector("#avatar-message");
const statusNode = document.querySelector("#status");
const statusActionButton = document.querySelector("#status-action");
const form = document.querySelector("#chat-form");
const questionInput = document.querySelector("#question");
const askButton = document.querySelector("#ask-button");
const stopButton = document.querySelector("#stop-button");
const answerNode = document.querySelector("#answer");

const AVATAR_URL = "/static/avatars/avatar.glb";
const BELLA_VOICE = "af_bella";
const CAMERA_PITCH = 0;
const WELCOME_MESSAGE = "Hi, I am Bella. I am here to help you with your questions. Ask me anything and I can answer it to the best of my ability.";
const MAX_CONVERSATION_EXCHANGES = 10;

let head = null;
let headtts = null;
let preparedVoice = null;
let latestAnswerText = "";
let statusAction = null;
let activeSpeechRetry = null;
let hasWelcomed = false;
let welcomeInProgress = false;
let conversationHistory = [];
let activeSpeechSession = null;

answerNode.textContent = WELCOME_MESSAGE;

const PRESENTER_HEAD_LIMITS = Object.freeze({
  x: 3,
  y: 5,
  z: 2,
});

function degreesToQuaternionComponent(degrees) {
  return Math.tan((degrees * Math.PI / 180) / 2);
}

function configurePresenterMode() {
  // Start from a neutral expression, then replace TalkingHead's broad idle
  // behavior with Bella's deliberately narrow presenter motion profile.
  head.mood.baseline.eyesLookDown = 0;
  head.setMood("neutral");

  const replacedAnimations = new Set([
    "pose",
    "head",
    "eyes",
    "blink",
    "mouth",
    "misc",
    "headmove",
    "lookat",
    "talkinghands",
  ]);
  head.animQueue = head.animQueue.filter(
    ({ template }) => !replacedAnimations.has(template?.name),
  );

  // Prevent body and audio-volume motion from expanding the effective head
  // rotation beyond the limits below.
  ["bodyRotateX", "bodyRotateY", "bodyRotateZ"].forEach((axis) => {
    head.setFixedValue(axis, 0);
  });
  head.volumeHeadVelocity = 0;
  head.volumeHeadCurrent = 0;

  // Ambient mouth expressions are disabled. Oculus viseme_* targets remain
  // free for the HeadTTS lip-sync animation supplied to speakAudio().
  head.getMorphTargetNames()
    .filter((name) => /^(jaw|mouth)/.test(name))
    .forEach((name) => head.setFixedValue(name, 0));

  const x = degreesToQuaternionComponent(PRESENTER_HEAD_LIMITS.x);
  const y = degreesToQuaternionComponent(PRESENTER_HEAD_LIMITS.y);
  const z = degreesToQuaternionComponent(PRESENTER_HEAD_LIMITS.z);

  const constrainedHead = {
    name: "presenter-head",
    delay: [1200, 2500],
    dt: [[2500, 4500], [2500, 4500], [1800, 3000]],
    vs: {
      headRotateX: [[-x, x], [-x, x], 0],
      headRotateY: [[-y, y], [-y, y], 0],
      headRotateZ: [[-z, z], [-z, z], 0],
    },
  };

  const cameraEyeContact = {
    name: "presenter-eye-contact",
    dt: [0, 60000],
    vs: {
      eyeContact: [1, 1],
      headMove: [0, 0],
    },
  };

  const naturalBlink = {
    name: "presenter-blink",
    delay: [2800, 5500],
    dt: [70, 110, 120],
    vs: {
      eyeBlinkLeft: [1, 1, 0],
      eyeBlinkRight: [1, 1, 0],
    },
  };

  head.animQueue.push(
    head.animFactory(constrainedHead, -1),
    head.animFactory(cameraEyeContact, -1),
    head.animFactory(naturalBlink, -1),
  );
}

function setStatus(message, state = "idle") {
  statusNode.textContent = message;
  statusNode.dataset.state = state;
}

function clearStatusAction() {
  statusAction = null;
  statusActionButton.hidden = true;
}

function showStatusAction(label, action) {
  statusAction = action;
  statusActionButton.textContent = label;
  statusActionButton.hidden = false;
}

function setStopButtonVisible(visible) {
  stopButton.hidden = !visible;
  stopButton.disabled = !visible;
}

function canAskQuestion() {
  return Boolean(head && hasWelcomed && !activeSpeechSession);
}

function finishSpeechSession(session) {
  if (activeSpeechSession !== session || session.finished) return;
  session.finished = true;
  activeSpeechSession = null;
  setStopButtonVisible(false);
  clearStatusAction();
  setStatus("Bella is ready", "ready");
  if (session.interruptible) askButton.disabled = !canAskQuestion();
}

function stopCurrentSpeech() {
  const session = activeSpeechSession;
  if (!session?.interruptible) return;

  session.cancelled = true;
  session.cancel();
  head?.stopSpeaking();
  if (headtts === session.engine) {
    headtts.clear();
    headtts = null;
    preparedVoice = null;
  }
  finishSpeechSession(session);
}

async function prepareVoice(onRetry = retryLatestSpeech) {
  const voice = BELLA_VOICE;
  if (headtts && preparedVoice === voice) return true;

  clearStatusAction();
  setStatus("Bella’s voice is getting ready…", "busy");
  let engine = null;
  try {
    headtts?.clear();
    engine = new HeadTTS({
      // Try browser GPU acceleration first; WASM remains a no-server-GPU fallback.
      endpoints: ["webgpu", "wasm"],
      voices: [voice],
      languages: ["en-us"],
      workerModule: "https://cdn.jsdelivr.net/npm/@met4citizen/headtts@1.3/modules/worker-tts.mjs",
      dictionaryURL: "https://cdn.jsdelivr.net/npm/@met4citizen/headtts@1.3/dictionaries/",
    });
    headtts = engine;
    engine.onmessage = (message) => {
      if (message.type === "audio") {
        const session = activeSpeechSession;
        if (headtts !== engine || !session || session.engine !== engine || session.cancelled) {
          return;
        }
        try {
          // HeadTTS already supplies visemes. Raw mode preserves that lip-sync
          // while preventing TalkingHead from adding a new gaze/gesture cycle.
          head?.speakAudio(message.data, { isRaw: true });
          session.hasAudio = true;
        } catch (error) {
          setStatus("Bella’s voice is unavailable", "error");
          showStatusAction("Retry", activeSpeechRetry || onRetry);
          console.error("Bella audio playback failed", error);
        }
      } else if (message.type === "error") {
        if (activeSpeechSession?.engine === engine && activeSpeechSession.cancelled) return;
        if (headtts === engine) {
          headtts = null;
          preparedVoice = null;
          setStatus("Bella’s voice is unavailable", "error");
          showStatusAction("Retry", activeSpeechRetry || onRetry);
        }
        console.error("Bella speech synthesis failed", message.data.error);
      }
    };
    engine.onerror = (error) => {
      if (activeSpeechSession?.engine === engine && activeSpeechSession.cancelled) return;
      if (headtts === engine) {
        headtts = null;
        preparedVoice = null;
        setStatus("Bella’s voice is unavailable", "error");
        showStatusAction("Retry", activeSpeechRetry || onRetry);
      }
      console.error("Bella voice initialization failed", error);
    };

    await engine.connect();
    await engine.setup({
      voice,
      language: "en-us",
      speed: 1,
      audioEncoding: "wav",
    });
    if (headtts !== engine) return false;
    preparedVoice = voice;
    setStatus("Bella is ready", "ready");
    return true;
  } catch (error) {
    engine?.clear();
    if (headtts === engine) {
      headtts = null;
      preparedVoice = null;
      setStatus("Bella’s voice is unavailable", "error");
      showStatusAction("Retry", onRetry);
    }
    console.error("Bella voice setup failed", error);
    return false;
  }
}

async function resumeAvatarAudio() {
  if (!head?.audioCtx) return false;
  if (head.audioCtx.state === "running") return true;
  try {
    const resumeAttempt = head.audioCtx.resume();
    await Promise.race([
      resumeAttempt,
      new Promise((resolve) => setTimeout(resolve, 800)),
    ]);
  } catch (error) {
    console.info("Bella audio is waiting for a user gesture", error);
  }
  return head.audioCtx.state === "running";
}

async function synthesizePreparedSpeech(text, onRetry, interruptible = false) {
  if (!headtts) return false;
  latestAnswerText = text;
  activeSpeechRetry = onRetry;
  clearStatusAction();
  setStatus("Bella is speaking…", "busy");
  let cancel = null;
  const session = {
    cancelled: false,
    engine: headtts,
    finished: false,
    hasAudio: false,
    interruptible,
    cancelledPromise: new Promise((resolve) => {
      cancel = resolve;
    }),
    cancel: () => cancel(),
  };
  activeSpeechSession = session;
  if (interruptible) {
    askButton.disabled = true;
    setStopButtonVisible(true);
  }
  try {
    const synthesized = await Promise.race([
      session.engine.synthesize({ input: text }).then(() => true),
      session.cancelledPromise.then(() => false),
    ]);
    if (!synthesized || activeSpeechSession !== session || session.cancelled) return false;
    if (!session.hasAudio) throw new Error("Bella did not receive synthesized audio");

    const played = await Promise.race([
      new Promise((resolve) => {
        head.speakMarker(() => {
          if (activeSpeechSession === session && !session.cancelled) {
            finishSpeechSession(session);
            resolve(true);
          }
        });
      }),
      session.cancelledPromise.then(() => false),
    ]);
    return played;
  } catch (error) {
    if (session.cancelled || activeSpeechSession !== session) return false;
    const failedEngine = headtts;
    headtts = null;
    preparedVoice = null;
    failedEngine?.clear();
    activeSpeechSession = null;
    setStopButtonVisible(false);
    setStatus("Bella’s voice is unavailable", "error");
    showStatusAction("Retry", onRetry);
    console.error("Bella speech failed", error);
    return false;
  }
}

async function retryLatestSpeech() {
  const audioReady = await resumeAvatarAudio();
  if (!audioReady) {
    setStatus("Bella’s voice is unavailable", "error");
    showStatusAction("Retry", retryLatestSpeech);
    return false;
  }
  const voiceReady = await prepareVoice(retryLatestSpeech);
  if (!voiceReady) return false;
  return synthesizePreparedSpeech(latestAnswerText, retryLatestSpeech, true);
}

async function startWelcome(userInitiated = false) {
  if (hasWelcomed) return true;
  if (welcomeInProgress) return false;

  welcomeInProgress = true;
  askButton.disabled = true;
  latestAnswerText = WELCOME_MESSAGE;
  answerNode.textContent = WELCOME_MESSAGE;
  clearStatusAction();

  const retryWelcome = () => startWelcome(true);
  try {
    let audioReady = false;
    if (userInitiated) audioReady = await resumeAvatarAudio();

    const voiceReady = await prepareVoice(retryWelcome);
    if (!voiceReady) return false;

    if (!audioReady) audioReady = await resumeAvatarAudio();
    if (!audioReady) {
      setStatus("Start Bella to hear her welcome", "idle");
      showStatusAction(userInitiated ? "Retry" : "Start Bella", retryWelcome);
      return false;
    }

    const spoken = await synthesizePreparedSpeech(WELCOME_MESSAGE, retryWelcome);
    if (spoken) {
      hasWelcomed = true;
      askButton.disabled = false;
      clearStatusAction();
    }
    return spoken;
  } finally {
    welcomeInProgress = false;
  }
}

async function loadAvatar() {
  clearStatusAction();
  setStopButtonVisible(false);
  askButton.disabled = true;
  avatarMessage.textContent = "Bella is getting ready…";
  avatarMessage.hidden = false;
  setStatus("Bella is getting ready…", "busy");
  try {
    head?.dispose();
    head = null;
    avatarNode.replaceChildren();
    head = new TalkingHead(avatarNode, {
      lipsyncLang: "en",
      lipsyncModules: ["en"],
      // Presenter-style idle behavior: hold the viewer's gaze rather than
      // frequently looking around or moving the head.
      avatarIdleEyeContact: 1,
      avatarIdleHeadMove: 0,
      avatarSpeakingEyeContact: 1,
      avatarSpeakingHeadMove: 0.08,
    });
    await head.showAvatar({
      url: AVATAR_URL,
      body: "F",
      avatarMood: "neutral",
      lipsyncLang: "en",
    });
    head.setView("head", { cameraRotateX: CAMERA_PITCH });
    configurePresenterMode();
    avatarMessage.hidden = true;
    await startWelcome();
    return true;
  } catch (error) {
    head?.dispose();
    head = null;
    avatarNode.replaceChildren();
    avatarMessage.textContent = "Bella couldn’t load.";
    avatarMessage.hidden = false;
    setStatus("Bella couldn’t load", "error");
    showStatusAction("Retry", loadAvatar);
    console.error("Bella avatar load failed", error);
    return false;
  }
}

async function speak(answer) {
  latestAnswerText = answer;
  if (!head) {
    setStatus("Bella couldn’t load", "error");
    showStatusAction("Retry", loadAvatar);
    return false;
  }
  const voiceReady = await prepareVoice(retryLatestSpeech);
  if (!voiceReady) return false;
  return synthesizePreparedSpeech(answer, retryLatestSpeech, true);
}

statusActionButton.addEventListener("click", async () => {
  if (!statusAction) return;
  const action = statusAction;
  clearStatusAction();
  statusActionButton.disabled = true;
  try {
    await action();
  } finally {
    statusActionButton.disabled = false;
  }
});

stopButton.addEventListener("click", stopCurrentSpeech);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = questionInput.value.trim();
  if (!message) return;

  askButton.disabled = true;
  clearStatusAction();

  if (conversationHistory.length >= MAX_CONVERSATION_EXCHANGES * 2) {
    conversationHistory = [];
    setStatus("Starting a new conversation…", "busy");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  setStatus("Bella is thinking…", "busy");
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history: conversationHistory }),
    });
    if (!response.ok) throw new Error(`Chat request failed: ${response.status}`);
    const result = await response.json();
    answerNode.textContent = result.answer;
    conversationHistory.push(
      { role: "user", content: message },
      { role: "assistant", content: result.answer },
    );
    questionInput.value = "";
    await speak(result.answer);
  } catch (error) {
    answerNode.textContent = "Bella couldn’t complete that request. Please try again.";
    setStatus("Bella couldn’t complete the request", "error");
    console.error("Bella chat request failed", error);
  } finally {
    askButton.disabled = !canAskQuestion();
  }
});

loadAvatar();
