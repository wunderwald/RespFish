const WS_URL      = "ws://localhost:8765";
const HISTORY_LEN = 300;
const PADDING     = 0.08;

const history = new Float32Array(HISTORY_LEN);
let   histIdx = 0;
let   sampleCount = 0;

// slow-adapting range — expands instantly, shrinks at SHRINK_RATE per frame
const SHRINK_RATE = 0.0002;
let   adaptMin =  0.5;
let   adaptMax = -0.5;

const statusDot   = document.getElementById("status-dot");
const statusText  = document.getElementById("status-text");
const valEl       = document.getElementById("val");
const spsEl       = document.getElementById("sps");
const fish        = document.getElementById("fish");
const canvas      = document.getElementById("wave");
const ctx         = canvas.getContext("2d");
const streamSelect = document.getElementById("stream-select");

function setStatus(cls, text) {
  statusDot.className    = cls;
  statusText.textContent = text;
}

let lastTick = performance.now();
setInterval(() => {
  const elapsed = performance.now() - lastTick;
  lastTick = performance.now();
  spsEl.textContent = (sampleCount / elapsed * 1000).toFixed(0);
  sampleCount = 0;
}, 1000);

function draw() {
  const w = canvas.width  = canvas.offsetWidth;
  const h = canvas.height = canvas.offsetHeight;
  ctx.clearRect(0, 0, w, h);

  // find true min/max of current buffer
  let bufMin = Infinity, bufMax = -Infinity;
  for (let i = 0; i < HISTORY_LEN; i++) {
    if (history[i] < bufMin) bufMin = history[i];
    if (history[i] > bufMax) bufMax = history[i];
  }
  // expand immediately, shrink very slowly
  if (bufMin < adaptMin) adaptMin = bufMin;
  else                   adaptMin += (bufMin - adaptMin) * SHRINK_RATE;
  if (bufMax > adaptMax) adaptMax = bufMax;
  else                   adaptMax -= (adaptMax - bufMax) * SHRINK_RATE;

  const min   = adaptMin;
  const range = (adaptMax - adaptMin) || 1;
  const pad    = PADDING * h;
  const usable = h - pad * 2;

  ctx.shadowColor = "rgba(255,255,255,0.6)";
  ctx.shadowBlur  = 8;
  ctx.beginPath();
  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.lineWidth   = 2.5;
  ctx.lineJoin    = "round";
  ctx.lineCap     = "round";

  const traceEnd = w * (2 / 3);
  for (let i = 0; i < HISTORY_LEN; i++) {
    const idx  = (histIdx + i) % HISTORY_LEN;
    const x    = (i / (HISTORY_LEN - 1)) * traceEnd;
    const norm = (history[idx] - min) / range;
    const y    = h - pad - norm * usable;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  // snap fish to the live tip of the trace
  const latestNorm = (history[(histIdx + HISTORY_LEN - 1) % HISTORY_LEN] - min) / range;
  const targetY = h - pad - latestNorm * usable;
  fish.style.setProperty("--fish-y", targetY.toFixed(2) + "px");

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// ── stream selector state ─────────────────────────────────────────────
let ws                = null;
let selectedStream    = null;   // name string or null
let streamConnected   = false;
let currentStreams     = [];    // latest list from server

function sendMsg(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function rebuildDropdown() {
  streamSelect.innerHTML = "";

  const isOffline = selectedStream && !streamConnected;

  // If selected stream is currently offline, show it first with a badge
  if (isOffline) {
    const opt = document.createElement("option");
    opt.value              = selectedStream;
    opt.textContent        = selectedStream + " (offline)";
    opt.dataset.offline    = "true";
    streamSelect.appendChild(opt);
  }

  // Add all discovered streams (skip if already shown as offline above)
  for (const s of currentStreams) {
    if (isOffline && s.name === selectedStream) continue;
    const opt = document.createElement("option");
    opt.value       = s.name;
    opt.textContent = s.name;
    streamSelect.appendChild(opt);
  }

  // Fallback: no entries at all
  if (streamSelect.options.length === 0) {
    const opt = document.createElement("option");
    opt.value    = "";
    opt.disabled = true;
    opt.textContent = "no streams found";
    streamSelect.appendChild(opt);
    streamSelect.value = "";
    return;
  }

  if (selectedStream) {
    streamSelect.value = selectedStream;
  } else if (currentStreams.length > 0) {
    // Auto-select first available stream
    const first = currentStreams[0].name;
    streamSelect.value = first;
    selectedStream = first;
    sendMsg({ type: "select_stream", name: first });
  }
}

streamSelect.addEventListener("change", () => {
  const name = streamSelect.value;
  if (name) {
    selectedStream  = name;
    streamConnected = false;
    rebuildDropdown();
    sendMsg({ type: "select_stream", name });
  }
});

// ── websocket ─────────────────────────────────────────────────────────
function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => setStatus("searching", "waiting for stream…");

  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);

    if (msg.type === "streams") {
      currentStreams = msg.streams;
      rebuildDropdown();

    } else if (msg.type === "sample") {
      history[histIdx] = msg.value;
      histIdx = (histIdx + 1) % HISTORY_LEN;
      sampleCount++;
      valEl.textContent = msg.value.toFixed(3);

    } else if (msg.type === "connected") {
      streamConnected = true;
      selectedStream  = msg.stream.name;
      rebuildDropdown();
      setStatus("connected", msg.stream.name);

    } else if (msg.type === "disconnected") {
      streamConnected = false;
      rebuildDropdown();
      setStatus("disconnected", "stream lost…");
      valEl.textContent = "—";

    } else if (msg.type === "searching") {
      setStatus("searching", "searching…");
    }
  };

  ws.onclose = () => {
    streamConnected = false;
    rebuildDropdown();
    setStatus("disconnected", "reconnecting…");
    setTimeout(connect, 3000);
  };
}

connect();
