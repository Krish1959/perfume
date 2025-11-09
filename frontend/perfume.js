// -----------------------------------------------------
// API base: works for both file:// and http://
// If index.html already set window.API_BASE, keep it.
if (!window.API_BASE || typeof window.API_BASE !== "string") {
  window.API_BASE =
    (location.protocol === "file:" || location.hostname === "localhost")
      ? "http://localhost:8000"
      : "";
}

// ---------- helpers ----------
function $(id){ return document.getElementById(id); }
function setStatus(msg){ $("viewerStatus").textContent = msg; }

// On-page debug + send to server
function uiLog(area, message, extra = {}) {
  try {
    const box = $("uiDebug");
    const ts  = new Date().toLocaleTimeString();
    const line = `[${ts}] [${area}] ${message}` + (Object.keys(extra).length ? ` | ${JSON.stringify(extra)}` : "");
    box.value += (box.value ? "\n" : "") + line;
    box.scrollTop = box.scrollHeight;
  } catch {}
}
async function flog(area, message, extra = {}, level = "INFO") {
  uiLog(area, message, extra);
  try {
    await fetch(`${window.API_BASE}/api/log`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ area, message, extra, level })
    });
  } catch {}
}

// ---------- refs ----------
const nameEl   = $("aname");
const videoEl  = $("avatarVideo");
const audioEl  = $("avatarAudio");
const gateEl   = $("audioGate");
const gateBtn  = $("enableBtn");

const editBox  = $("editBox");
const micBtn   = $("btn-mic");
const sendBtn  = $("btn-send-avatar");
const instrBtn = $("btn-instruction");
const gptBtn   = $("btn-chatgpt");
const startBtn = $("btn-start");
const stopBtn  = $("btn-stop");

// ---------- state ----------
let SESSION_ID = null, SESSION_TOKEN = null, OFFER_SDP = null, pc = null;
let RTC_CONFIG = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };

// ---------- initial ping ----------
(async () => {
  try {
    const r = await fetch(`${window.API_BASE}/api/ping`);
    await flog("frontend", "perfume.js loaded", { api_base: window.API_BASE, ping: r.status });
    setStatus("Ready.");
  } catch (e) {
    await flog("frontend", "perfume.js load error", { err: String(e), api_base: window.API_BASE }, "ERROR");
    setStatus("Backend not reachable at " + window.API_BASE);
  }
})();

// ---------- audio gate ----------
async function ensureAudio() {
  try {
    audioEl.muted = false;
    audioEl.volume = 1.0;
    await audioEl.play();
    gateEl.style.display = "none";
  } catch {
    gateEl.style.display = "flex";
  }
}
gateBtn.addEventListener("click", ensureAudio);

// ---------- start/stop session ----------
async function startSession() {
  const body = {
    avatar_id: window.HEYGEN_FIXED && window.HEYGEN_FIXED.avatar_id ? window.HEYGEN_FIXED.avatar_id : "June_HR_public",
    voice_id:  window.HEYGEN_FIXED && window.HEYGEN_FIXED.voice_id  ? window.HEYGEN_FIXED.voice_id  : "68dedac41a9f46a6a4271a95c733823c",
    pose_name: window.HEYGEN_FIXED && window.HEYGEN_FIXED.pose_name ? window.HEYGEN_FIXED.pose_name : "June HR"
  };
  await flog("viewer", "Start button pressed", body);
  setStatus("requesting viewer params…");

  let j = null;
  try {
    const r = await fetch(`${window.API_BASE}/api/start-session`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(body)
    });
    j = await r.json().catch(()=>({}));
    await flog("viewer", "/api/start-session response", { http: r.status, body: j });
    if (r.status >= 400 || !j.offer_sdp) throw new Error("start-session failed or no offer_sdp");
  } catch (e) {
    await flog("viewer", "start-session failed", { err: String(e) }, "ERROR");
    setStatus("init error (start-session)");
    return;
  }

  nameEl.textContent = j.avatar_name || "—";
  SESSION_ID    = j.session_id;
  SESSION_TOKEN = j.session_token;
  OFFER_SDP     = j.offer_sdp;
  RTC_CONFIG    = j.rtc_config || RTC_CONFIG;

  try {
    if (pc) { try { pc.close(); } catch {} }
    pc = new RTCPeerConnection(RTC_CONFIG);
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.addTransceiver("video", { direction: "recvonly" });

    pc.ontrack = (ev) => {
      const streams = ev.streams || [];
      const stream = streams[0];
      if (!stream) return;
      if (ev.track.kind === "video") {
        videoEl.srcObject = stream;
        videoEl.muted = true;
        videoEl.play().catch(()=>{});
      } else if (ev.track.kind === "audio") {
        audioEl.srcObject = stream;
        setTimeout(ensureAudio, 100);
      }
    };

    setStatus("applying offer…");
    await pc.setRemoteDescription({ type: "offer", sdp: OFFER_SDP });

    setStatus("creating answer…");
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await new Promise(res => {
      if (pc.iceGatheringState === "complete") return res();
      const h = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", h); res();
        }
      };
      pc.addEventListener("icegatheringstatechange", h);
      setTimeout(res, 1500);
    });

    setStatus("starting on HeyGen…");
    const fd = new FormData();
    fd.append("session_id",    SESSION_ID);
    fd.append("session_token", SESSION_TOKEN);
    fd.append("answer_sdp",    pc.localDescription.sdp);

    const rStart = await fetch(`${window.API_BASE}/api/heygen/start`, { method: "POST", body: fd });
    const jStart = await rStart.json().catch(()=>({}));
    await flog("viewer", "/api/heygen/start response", { http: rStart.status, body: jStart });

    if (rStart.status >= 400) throw new Error("heygen.start failed");

    setStatus("waiting for media…");
    gateEl.style.display = "flex";
  } catch (e) {
    await flog("viewer", "webrtc/start error", { err: String(e) }, "ERROR");
    setStatus("init error (webrtc)");
  }
}

async function stopSession() {
  await flog("viewer", "Stop button pressed");
  try {
    const r = await fetch(`${window.API_BASE}/api/stop-session`, { method: "POST" });
    const j = await r.json().catch(()=>({}));
    await flog("viewer", "/api/stop-session response", { http: r.status, body: j });
  } catch (e) {
    await flog("viewer", "stop-session error", { err: String(e) }, "ERROR");
  }
  if (pc) { try { pc.close(); } catch {} pc = null; }
  setStatus("stopped.");
}
window.addEventListener("beforeunload", () => {
  try { navigator.sendBeacon(`${window.API_BASE}/api/stop-session`, new FormData()); } catch {}
});

startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);

// ---------- send to avatar ----------
sendBtn.addEventListener("click", async () => {
  const text = (editBox.value || "").trim();
  if (!text) return;
  if (!(SESSION_ID && SESSION_TOKEN)) { setStatus("Start session first."); return; }

  const payload = { session_id: SESSION_ID, session_token: SESSION_TOKEN, text };
  await flog("viewer", "Send to avatar clicked", { text_len: text.length });

  const r = await fetch(`${window.API_BASE}/api/send-task`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(()=>({}));
  await flog("viewer", "/api/send-task response", { http: r.status, body: j });
});

// ---------- instruction ----------
instrBtn.addEventListener("click", async () => {
  const msg = "To speak to me, press the microphone button, pause a second and then speak. Once finished, press Stop.";
  editBox.value = msg;
  await flog("viewer", "Instruction pressed", { text: msg });
  sendBtn.click();
});

// ---------- ChatGPT ----------
gptBtn.addEventListener("click", async () => {
  const text = (editBox.value || "").trim();
  if (!text) {
    await flog("chatgpt", "Send to ChatGPT pressed (empty text)");
  } else {
    await flog("chatgpt", "Send to ChatGPT pressed", { text_len: text.length });
  }
  setStatus("Sending to ChatGPT…");

  try {
    const fd = new FormData();
    fd.append("text", text || "Hello");

    const r = await fetch(`${window.API_BASE}/api/chat`, { method: "POST", body: fd });
    const j = await r.json().catch(()=>({}));
    await flog("chatgpt", "/api/chat response", { http: r.status, body_len: (j && j.response ? j.response.length : 0) });

    if (r.status >= 400) {
      setStatus("OpenAI error (see debug box)");
      return;
    }

    const reply = (j && j.response ? j.response : "").trim();
    if (reply) {
      editBox.value = reply;
      if (SESSION_ID && SESSION_TOKEN) {
        const payload = { session_id: SESSION_ID, session_token: SESSION_TOKEN, text: reply };
        fetch(`${window.API_BASE}/api/send-task`, {
          method: "POST",
          headers: {"Content-Type":"application/json"},
          body: JSON.stringify(payload)
        }).catch(()=>{});
      }
    }
    setStatus("Ready.");
  } catch (e) {
    await flog("chatgpt", "error", { err: String(e) }, "ERROR");
    setStatus("OpenAI error");
  }
});

// ---------- mic + voicechat ----------
let mediaRecorder = null, chunks = [], audioCtx = null, analyser = null, sourceNode = null, raf = 0;
let recT0 = 0;

function chooseMime() {
  const c = [
    "audio/webm;codecs=opus","audio/webm",
    "audio/ogg;codecs=opus","audio/ogg",
    "audio/mp4","audio/mpeg"
  ];
  for (const m of c) { if (MediaRecorder.isTypeSupported(m)) return m; }
  return "";
}

async function startRecording() {
  await flog("mic", "StartRecording pressed");
  try {
    editBox.value = "";
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 2048;
    sourceNode = audioCtx.createMediaStreamSource(stream); sourceNode.connect(analyser);

    const mimeType = chooseMime(); chunks = [];
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    mediaRecorder.onstop = async () => {
      const recT1 = Date.now();
      cancelAnimationFrame(raf);
      if (sourceNode) { try { sourceNode.disconnect(); } catch {} }

      const totalBytes = chunks.reduce((a,b)=>a+(b.size||0),0);
      await flog("mic", "EndRecording fired", { chunks: chunks.length, totalBytes, duration_ms: recT1 - recT0 });

      try {
        const type = (chunks[0] && chunks[0].type) ? chunks[0].type : (mediaRecorder && mediaRecorder.mimeType ? mediaRecorder.mimeType : (mimeType || "audio/webm"));
        const blob = new Blob(chunks, { type });
        const file = new File([blob], "mic.webm", { type });

        const fd = new FormData();
        fd.append("file", file);

        setStatus("Sending to ChatGPT…");
        await flog("mic", "sending to /api/voicechat", { type, size: blob.size });

        const r = await fetch(`${window.API_BASE}/api/voicechat`, { method: "POST", body: fd });
        const j = await r.json().catch(()=>({}));
        await flog("mic", "/api/voicechat response", { http: r.status, body_len: (j && j.text ? j.text.length : 0) });

        if (j && typeof j.text === "string") {
          editBox.value = j.text.trim();
          setStatus("Ready.");
        } else {
          setStatus("Voicechat returned no text.");
        }
      } catch (e) {
        await flog("mic", "voicechat error", { err: String(e) }, "ERROR");
        setStatus("Voicechat error");
      } finally {
        try { stream.getTracks().forEach(t => t.stop()); } catch {}
        mediaRecorder = null;
        micBtn.classList.remove("recording");
        micBtn.textContent = "🎙️ Start Recording";
      }
    };

    mediaRecorder.start();
    recT0 = Date.now();

    setStatus("Listening… press again to stop");
    micBtn.classList.add("recording");
    micBtn.textContent = "⏹ End Recording";
    const tick = () => { raf = requestAnimationFrame(tick); }; tick();
  } catch (err) {
    await flog("mic", "permission/error", { err: String(err) }, "ERROR");
    setStatus(`Mic permission denied / ${err.message || err}`);
    micBtn.classList.remove("recording");
    micBtn.textContent = "🎙️ Start Recording";
  }
}
function stopRecording(){
  if (mediaRecorder) {
    try { mediaRecorder.stop(); } catch {}
  }
}
micBtn.addEventListener("click", () => {
  if (mediaRecorder) { stopRecording(); }
  else { startRecording(); }
});

// ---------- NEW: explainPerfume helper ----------
async function explainPerfume(name) {
  const nm = (name || "").trim();
  if (!nm) return;

  editBox.value = nm;
  await flog("tiles", "tile pressed", { name: nm });
  if (SESSION_ID && SESSION_TOKEN) {
    const payload = { session_id: SESSION_ID, session_token: SESSION_TOKEN, text: nm };
    fetch(`${window.API_BASE}/api/send-task`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    }).catch(()=>{});
  }

  try {
    setStatus("Getting perfume details…");
    const fd = new FormData();
    fd.append("name", nm);
    const r = await fetch(`${window.API_BASE}/api/perfume-explain`, { method: "POST", body: fd });
    const j = await r.json().catch(()=>({}));
    await flog("tiles", "/api/perfume-explain response", { http: r.status, body_len: (j && j.response ? j.response.length : 0) });

    if (r.status >= 400) { setStatus("OpenAI error (see debug)"); return; }

    const reply = (j && j.response ? j.response : "").trim();
    if (reply) {
      editBox.value = reply;
      if (SESSION_ID && SESSION_TOKEN) {
        const payload = { session_id: SESSION_ID, session_token: SESSION_TOKEN, text: reply };
        fetch(`${window.API_BASE}/api/send-task`, {
          method: "POST",
          headers: {"Content-Type":"application/json"},
          body: JSON.stringify(payload)
        }).catch(()=>{});
      }
    }
    setStatus("Ready.");
  } catch (e) {
    await flog("tiles", "perfume-explain error", { err: String(e) }, "ERROR");
    setStatus("OpenAI error");
  }
}

// ---------- tiles ----------
$("perfumeGrid").addEventListener("click", async (e) => {
  const fig = e.target.closest(".perfume-item");
  if (!fig) return;

  const cap = fig.querySelector("figcaption");
  const say = (fig.getAttribute("data-say") || (cap ? cap.textContent : "") || "").trim();
  if (!say) return;

  explainPerfume(say);
});
