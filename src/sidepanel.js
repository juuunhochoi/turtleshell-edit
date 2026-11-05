const $ = (id) => document.getElementById(id);
const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const calibrateBtn = $("calibrateBtn");
const statusDetail = $("statusDetail");
const statusDot = $("statusDot");
const scoreBar = $("scoreBar");
const scoreTrack = scoreBar.parentElement;
const meetingToggle = $("meetingToggle");
const cameraSelect = $("cameraSelect");
const cameraPreview = $("cameraPreview");
const previewModeToggle = $("previewModeToggle");
function setPreviewMode(silhouetteOnly) {
  previewModeToggle.checked = silhouetteOnly;
}

chrome.storage.local.get({ silhouetteOnlyPreview: false }).then(({ silhouetteOnlyPreview }) => {
  setPreviewMode(silhouetteOnlyPreview);
}).catch(() => {});

async function togglePreviewMode() {
  const result = await chrome.runtime.sendMessage({ type: "POSTUREFLOW_TOGGLE_PREVIEW_MODE" }).catch(() => null);
  if (result) setPreviewMode(result.silhouetteOnly);
}
previewModeToggle.addEventListener("change", togglePreviewMode);
const previewFrame = cameraPreview.parentElement;

// guide: null = hidden (calibrated / off), true/false = whether the user sits centred for setup.
function setGuide(guide) {
  previewFrame.classList.toggle("guide", guide === true || guide === false);
  previewFrame.classList.toggle("aligned", guide === true);
  $("guideLabel").textContent = guide ? "좋아요! 기준 자세 버튼을 누르세요" : "얼굴과 어깨가 화면 가운데 오게 앉아 주세요";
}

const VIRTUAL_CAMERA_LABEL = /\b(?:obs|virtual|virtualcam|droidcam|iriun|manycam|xsplit|snap camera|mmhmm|camo)\b/i;
const BUILT_IN_CAMERA_LABEL = /built[ -]?in|integrated|internal|webcam|facetime|front camera|내장|웹캠/i;

function setStatus(active, _title, detail) {
  statusDot.classList.toggle("active", active);
  statusDetail.textContent = detail || "";
}

function setDetecting(active) {
  startBtn.disabled = active;
  stopBtn.disabled = !active;
  calibrateBtn.disabled = !active;
  startBtn.classList.toggle("primary", !active);
  startBtn.classList.toggle("secondary", active);
  calibrateBtn.classList.toggle("primary", active);
  calibrateBtn.classList.toggle("secondary", !active);
}

async function fillCameras() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "videoinput");
  const { cameraId } = await chrome.storage.local.get("cameraId");
  const nonVirtual = devices.filter(device => !VIRTUAL_CAMERA_LABEL.test(device.label));
  const cameras = nonVirtual.length ? nonVirtual : devices;
  if (!cameras.length) {
    cameraSelect.replaceChildren(new Option("사용 가능한 카메라 없음", ""));
    return;
  }
  const selected = cameras.some(device => device.deviceId === cameraId)
    ? cameraId
    : (cameras.find(device => BUILT_IN_CAMERA_LABEL.test(device.label)) || cameras[0]).deviceId;
  cameraSelect.replaceChildren(...cameras.map((device, index) =>
    new Option(device.label || `카메라 ${index + 1}`, device.deviceId, false, device.deviceId === selected)));
  if (cameraId !== selected && cameras.every(device => device.label)) {
    await chrome.storage.local.set({ cameraId: selected });
  }
}
fillCameras().catch(() => {});

async function openPermissionPopup(reason) {
  setStatus(false, "카메라 권한 필요", `작은 창에서 '허용'을 누르면 감지를 시작합니다. [${reason}]`);
  await chrome.windows.create({ url: chrome.runtime.getURL("permission.html"), type: "popup", width: 460, height: 320 });
}

async function requestDetectionStart() {
  try {
    if (cameraSelect.value) await chrome.storage.local.set({ cameraId: cameraSelect.value });
    const permission = await navigator.permissions.query({ name: "camera" }).catch(() => null);
    if (permission && permission.state !== "granted") {
      await openPermissionPopup(`권한 상태: ${permission.state}`);
      return;
    }
    setStatus(false, "카메라 연결 중…", "카메라를 여는 중입니다.");
    const result = await chrome.runtime.sendMessage({ type: "POSTUREFLOW_START_DETECTION" });
    if (!result?.ok) setStatus(false, "카메라 시작 실패", result?.error || "감지를 시작하지 못했습니다.");
  } catch (error) {
    setStatus(false, "카메라 시작 실패", error?.message || "감지를 시작하지 못했습니다.");
  }
}

startBtn.addEventListener("click", requestDetectionStart);
stopBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "POSTUREFLOW_STOP_DETECTION" }));
calibrateBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "POSTUREFLOW_CALIBRATE" }));
cameraSelect.addEventListener("change", async () => {
  await chrome.storage.local.set({ cameraId: cameraSelect.value });
  const state = await chrome.runtime.sendMessage({ type: "POSTUREFLOW_GET_STATUS" }).catch(() => null);
  if (state?.active) {
    await chrome.runtime.sendMessage({ type: "POSTUREFLOW_START_DETECTION" });
  }
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "POSTUREFLOW_UI_STATE") {
    setStatus(!!message.active, message.title, message.detail || message.reason);
    setDetecting(!!message.active);
    if (!message.active) {
      scoreBar.style.width = "0%";
      scoreTrack.setAttribute("aria-valuenow", "0");
      cameraPreview.style.display = "none";
      setGuide(null);
    }
  }
  if (message?.type === "POSTUREFLOW_UI_PREVIEW") {
    if (message.data) {
      cameraPreview.src = message.data;
      cameraPreview.style.display = "block";
      setGuide(message.guide);
    } else {
      cameraPreview.removeAttribute("src");
      cameraPreview.style.display = "none";
      setGuide(null);
    }
  }
  if (message?.type === "POSTUREFLOW_UI_SCORE") {
    const score = Number(message.displayScore) || 0;
    scoreBar.style.width = `${Math.round((score / 10) * 100)}%`;
    scoreTrack.setAttribute("aria-valuenow", score.toFixed(1));
  }
  if (message?.type === "POSTUREFLOW_UI_HINT") statusDetail.textContent = message.hint;
  if (message?.type === "POSTUREFLOW_UI_CALIBRATED") {
    calibrateBtn.classList.remove("primary");
    calibrateBtn.classList.add("secondary");
    setGuide(null);
    statusDetail.textContent = "이제 자세를 감지합니다.";
  }
  if (message?.type === "CAMERA_GRANTED") fillCameras().catch(() => {});
});

chrome.runtime.sendMessage({ type: "POSTUREFLOW_GET_STATUS" }).then(state => {
  if (!state) return;
  setStatus(state.active, state.title, state.detail);
  setDetecting(state.active);
  meetingToggle.checked = state.meetingSuspend !== false;
}).catch(() => {});

meetingToggle.addEventListener("change", () => {
  chrome.runtime.sendMessage({ type: "POSTUREFLOW_SET_MEETING_SUSPEND", enabled: meetingToggle.checked });
});

chrome.storage.sync.get(["postureMessage", "tiltIntensity"], data => {
  const messageInput = $("posture-message-input");
  if (messageInput && data.postureMessage) messageInput.value = data.postureMessage;
  if (data.tiltIntensity) {
    $("tiltIntensityRange").value = data.tiltIntensity;
    $("tiltValue").textContent = data.tiltIntensity;
  }
});

$("save-message-btn").addEventListener("click", () => {
  const text = $("posture-message-input").value.trim() || "자세를 고치자";
  chrome.storage.sync.set({ postureMessage: text });
  chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
    if (tab?.id != null) chrome.tabs.sendMessage(tab.id, { type: "POSTUREFLOW_UPDATE_TEXT", text }).catch(() => {});
  });
});

async function broadcastToAllTabs(message) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter(tab => tab.id != null).map(tab => chrome.tabs.sendMessage(tab.id, message).catch(() => {})));
}

const timerPlayPauseBtn = $("timerPlayPauseBtn");
const timerStopBtn = $("timerStopBtn");
const workTimeInput = $("workTimeInput");
const breakTimeInput = $("breakTimeInput");
const timerCountdown = $("timerCountdown");
const timerPhase = $("timerPhase");
let timerDisplayInterval = null;
let standingTimer = null;
function formatTimerTime(milliseconds) {
  const remainingSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(remainingSeconds / 60), seconds = remainingSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
function renderIdleTimer() {
  timerCountdown.textContent = formatTimerTime(Number(workTimeInput.value) * 60_000 || 0);
  timerPhase.textContent = "집중 중";
}
for (const input of [workTimeInput, breakTimeInput]) {
  input.addEventListener("input", () => {
    if (input.value && (!Number.isInteger(Number(input.value)) || Number(input.value) < 1)) input.value = "";
    if (!standingTimer?.active) renderIdleTimer();
  });
}
function renderStandingTimer(timer) {
  standingTimer = timer;
  if (timerDisplayInterval) clearInterval(timerDisplayInterval);
  if (!timer?.active) {
    timerPlayPauseBtn.classList.remove("is-running");
    timerPlayPauseBtn.setAttribute("aria-label", "타이머 시작");
    timerPlayPauseBtn.title = "타이머 시작";
    timerStopBtn.disabled = true;
    renderIdleTimer();
    return;
  }
  workTimeInput.value = String(timer.workDurationMs / 60_000);
  breakTimeInput.value = String(timer.breakDurationMs / 60_000);
  timerStopBtn.disabled = false;
  timerPlayPauseBtn.classList.toggle("is-running", !timer.paused);
  timerPlayPauseBtn.setAttribute("aria-label", timer.paused ? "타이머 재개" : "타이머 일시정지");
  timerPlayPauseBtn.title = timer.paused ? "타이머 재개" : "타이머 일시정지";
  const updateCountdown = () => {
    const remainingMs = timer.paused ? timer.remainingMs : timer.endsAt - Date.now();
    const phase = timer.isBreakTime ? "휴식 중" : "집중 중";
    timerCountdown.textContent = formatTimerTime(remainingMs);
    timerPhase.textContent = timer.paused ? `일시정지 · ${phase}` : phase;
  };
  updateCountdown();
  if (!timer.paused) timerDisplayInterval = setInterval(updateCountdown, 1000);
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "POSTUREFLOW_TIMER_STATE") renderStandingTimer(message.timer);
});

chrome.runtime.sendMessage({ type: "POSTUREFLOW_TIMER_GET" }).then(renderStandingTimer).catch(() => {});

timerPlayPauseBtn.addEventListener("click", async () => {
  if (standingTimer?.active) {
    const response = await chrome.runtime.sendMessage({ type: standingTimer.paused ? "POSTUREFLOW_TIMER_RESUME" : "POSTUREFLOW_TIMER_PAUSE" });
    if (response?.timer) renderStandingTimer(response.timer);
    return;
  }
  const invalid = [workTimeInput, breakTimeInput].find(input => !input.value || !input.checkValidity() || !Number.isInteger(Number(input.value)) || Number(input.value) < 1);
  if (invalid) {
    invalid.reportValidity();
    invalid.focus();
    return;
  }
  const workMinutes = Number(workTimeInput.value), breakMinutes = Number(breakTimeInput.value);
  const response = await chrome.runtime.sendMessage({ type: "POSTUREFLOW_TIMER_START", workMinutes, breakMinutes });
  if (response?.timer) renderStandingTimer(response.timer);
});

timerStopBtn.addEventListener("click", async () => {
  if (!standingTimer?.active) return;
  const response = await chrome.runtime.sendMessage({ type: "POSTUREFLOW_TIMER_STOP" });
  if (response?.timer) renderStandingTimer(response.timer);
});

const tiltRange = $("tiltIntensityRange");
tiltRange.addEventListener("input", () => {
  const value = Number(tiltRange.value);
  $("tiltValue").textContent = value;
  chrome.storage.sync.set({ tiltIntensity: value });
  broadcastToAllTabs({ type: "POSTUREFLOW_UPDATE_TILT_CONFIG", intensity: value });
});
