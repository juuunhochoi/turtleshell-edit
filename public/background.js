const MEETING_HOSTS = ["meet.google.com", "app.zoom.us", "zoom.us", "teams.microsoft.com", "teams.live.com"];
const STANDING_TIMER_ALARM = "turtleshell-standing-timer";
const DEFAULT_STANDING_TIMER = { active: false, paused: false, isBreakTime: false, workDurationMs: 0, breakDurationMs: 0, endsAt: 0, remainingMs: 0 };
const sessionDefaults = { active: false, score: 0, effects: true, meetingSuspend: true, title: "카메라 꺼짐", detail: "시작을 누르면 자세 분석을 시작합니다." };
let stateCache = null;
let activeTabId = null;
let activeTabResolved = false;
let lastScorePersistTime = 0;

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  stateCache = { ...sessionDefaults };
  await chrome.storage.session.set(sessionDefaults);
  await restoreStandingTimer();
});

chrome.runtime.onStartup.addListener(() => restoreStandingTimer());

async function getState() {
  if (!stateCache) stateCache = { ...sessionDefaults, ...(await chrome.storage.session.get(sessionDefaults)) };
  return stateCache;
}

async function persistState(patch) {
  const state = await getState();
  Object.assign(state, patch);
  await chrome.storage.session.set(patch);
  return state;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  activeTabId = tab?.id ?? null;
  activeTabResolved = true;
  return tab;
}

async function sendToTab(tabId, message) {
  try { await chrome.tabs.sendMessage(tabId, message); return true; } catch { return false; /* Restricted pages may not accept content scripts. */ }
}

// The score reaches the side panel but the tab can't show the blur when it has no live content script:
// chrome:// pages, the Web Store, or tabs left open while the extension was reloaded/updated.
// Tell the user once per tab instead of failing silently.
const unreachableHinted = new Set();
async function hintUnreachableTab(tabId) {
  if (unreachableHinted.has(tabId)) return;
  unreachableHinted.add(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const restricted = !/^https?:/.test(tab?.url || "");
  chrome.runtime.sendMessage({
    type: "POSTUREFLOW_UI_HINT",
    hint: restricted
      ? "이 페이지에서는 화면 효과를 쓸 수 없어요. 일반 웹사이트 탭에서 확인해 주세요."
      : "이 탭은 새로고침(F5)해야 화면 효과가 나타나요. 확장 프로그램을 다시 불러오기 전에 열어 둔 탭이에요."
  }).catch(() => {});
}

async function broadcast(message) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter(tab => tab.id != null).map(tab => sendToTab(tab.id, message)));
}

async function getStandingTimer() {
  const { standingTimer = DEFAULT_STANDING_TIMER } = await chrome.storage.local.get("standingTimer");
  return { ...DEFAULT_STANDING_TIMER, ...standingTimer };
}

async function publishStandingTimer(timer, updateTabs = false) {
  await chrome.storage.session.set({ isBreakTime: !!timer.active && !!timer.isBreakTime });
  chrome.runtime.sendMessage({ type: "POSTUREFLOW_TIMER_STATE", timer }).catch(() => {});
  if (updateTabs) await broadcast({ type: "POSTUREFLOW_TRAPEZOID_MODE", active: !!timer.active && !!timer.isBreakTime });
}

async function advanceStandingTimer() {
  const timer = await getStandingTimer();
  if (!timer.active || timer.paused) return timer;
  const now = Date.now();
  let changed = false;
  while (timer.endsAt <= now) {
    timer.isBreakTime = !timer.isBreakTime;
    timer.endsAt += timer.isBreakTime ? timer.breakDurationMs : timer.workDurationMs;
    changed = true;
  }
  if (changed) {
    await chrome.storage.local.set({ standingTimer: timer });
    await publishStandingTimer(timer, true);
  }
  if (timer.active && !timer.paused) chrome.alarms.create(STANDING_TIMER_ALARM, { when: Math.max(Date.now() + 1000, timer.endsAt) });
  return timer;
}

async function restoreStandingTimer() {
  let timer = await getStandingTimer();
  if (timer.active && !timer.paused) timer = await advanceStandingTimer();
  if (timer.active && !timer.paused) chrome.alarms.create(STANDING_TIMER_ALARM, { when: Math.max(Date.now() + 1000, timer.endsAt) });
  await publishStandingTimer(timer, true);
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === STANDING_TIMER_ALARM) advanceStandingTimer().catch(() => {});
});

async function startStandingTimer(workMinutes, breakMinutes) {
  const timer = {
    active: true,
    paused: false,
    isBreakTime: false,
    workDurationMs: workMinutes * 60_000,
    breakDurationMs: breakMinutes * 60_000,
    endsAt: Date.now() + workMinutes * 60_000,
    remainingMs: 0
  };
  await chrome.storage.local.set({ standingTimer: timer });
  chrome.alarms.clear(STANDING_TIMER_ALARM);
  chrome.alarms.create(STANDING_TIMER_ALARM, { when: timer.endsAt });
  await publishStandingTimer(timer, true);
  return timer;
}

async function stopStandingTimer() {
  const timer = { ...DEFAULT_STANDING_TIMER };
  await chrome.storage.local.set({ standingTimer: timer });
  await chrome.alarms.clear(STANDING_TIMER_ALARM);
  await publishStandingTimer(timer, true);
  return timer;
}

async function pauseStandingTimer() {
  const timer = await getStandingTimer();
  if (!timer.active || timer.paused) return timer;
  timer.remainingMs = Math.max(0, timer.endsAt - Date.now());
  timer.paused = true;
  await chrome.storage.local.set({ standingTimer: timer });
  await chrome.alarms.clear(STANDING_TIMER_ALARM);
  await publishStandingTimer(timer, true);
  return timer;
}

async function resumeStandingTimer() {
  const timer = await getStandingTimer();
  if (!timer.active || !timer.paused) return timer;
  timer.endsAt = Date.now() + Math.max(1000, timer.remainingMs);
  timer.remainingMs = 0;
  timer.paused = false;
  await chrome.storage.local.set({ standingTimer: timer });
  chrome.alarms.create(STANDING_TIMER_ALARM, { when: timer.endsAt });
  await publishStandingTimer(timer, true);
  return timer;
}

function isMeetingUrl(url) {
  try {
    const host = new URL(url).hostname;
    return MEETING_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}

async function ensureOffscreen() {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  if (!contexts.length) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Keep user-started camera posture analysis running when the side panel is closed."
    });
  }
}

async function stopDetection(reason = "자세 감지를 중지했습니다.") {
  try { await chrome.runtime.sendMessage({ type: "POSTUREFLOW_OFFSCREEN_STOP" }); } catch {}
  await persistState({ active: false, score: 0, title: "카메라 꺼짐", detail: reason });
  await broadcast({ type: "POSTUREFLOW_STATE", active: false, reason });
  chrome.runtime.sendMessage({ type: "POSTUREFLOW_UI_STATE", active: false, reason }).catch(() => {});
}

async function startDetection() {
  const tab = await activeTab();
  const state = await getState();
  if (state.meetingSuspend && tab?.url && isMeetingUrl(tab.url)) {
    await persistState({ active: false, score: 0, title: "자동 중지됨", detail: "회의/화상통화 사이트에서는 자동으로 중지했습니다." });
    await broadcast({ type: "POSTUREFLOW_STATE", active: false, reason: "회의/화상통화 사이트에서는 자동으로 중지했습니다." });
    chrome.runtime.sendMessage({ type: "POSTUREFLOW_UI_STATE", active: false, reason: "회의/화상통화 사이트에서는 자동으로 중지했습니다." }).catch(() => {});
    return;
  }
  await ensureOffscreen();
  const { cameraId, silhouetteOnlyPreview = false } = await chrome.storage.local.get(["cameraId", "silhouetteOnlyPreview"]);
  await persistState({ active: true, score: 0, title: "카메라 연결 중…", detail: "카메라를 여는 중입니다." });
  chrome.runtime.sendMessage({ type: "POSTUREFLOW_OFFSCREEN_START", cameraId, silhouetteOnlyPreview }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "POSTUREFLOW_START_DETECTION") {
    startDetection().then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "CAMERA_GRANTED") {
    startDetection().catch(() => {});
    return false;
  }
  if (message?.type === "POSTUREFLOW_STOP_DETECTION") {
    stopDetection(message.reason).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "POSTUREFLOW_CALIBRATE") {
    chrome.runtime.sendMessage({ type: "POSTUREFLOW_OFFSCREEN_CALIBRATE" }).catch(() => {});
    return false;
  }
  if (message?.type === "POSTUREFLOW_GET_STATUS") {
    getState().then(sendResponse);
    return true;
  }
  if (message?.type === "POSTUREFLOW_SET_EFFECTS") {
    persistState({ effects: !!message.enabled });
    activeTab().then(tab => { if (tab?.id != null) sendToTab(tab.id, { type: "POSTUREFLOW_EFFECTS", enabled: !!message.enabled }); });
    return false;
  }
  if (message?.type === "POSTUREFLOW_SET_MEETING_SUSPEND") {
    persistState({ meetingSuspend: !!message.enabled });
    return false;
  }
  if (message?.type === "POSTUREFLOW_TOGGLE_PREVIEW_MODE") {
    chrome.storage.local.get({ silhouetteOnlyPreview: false }).then(async ({ silhouetteOnlyPreview }) => {
      const nextMode = !silhouetteOnlyPreview;
      await chrome.storage.local.set({ silhouetteOnlyPreview: nextMode });
      chrome.runtime.sendMessage({ type: "POSTUREFLOW_OFFSCREEN_PREVIEW_MODE", silhouetteOnly: nextMode }).catch(() => {});
      sendResponse({ silhouetteOnly: nextMode });
    });
    return true;
  }
  if (message?.type === "POSTUREFLOW_OFFSCREEN_STATUS") {
    persistState({ active: !!message.active, score: 0, title: message.title, detail: message.detail });
    chrome.runtime.sendMessage({ type: "POSTUREFLOW_UI_STATE", active: !!message.active, title: message.title, detail: message.detail }).catch(() => {});
    if (!message.active) broadcast({ type: "POSTUREFLOW_STATE", active: false, reason: message.detail });
    return false;
  }
  if (message?.type === "POSTUREFLOW_OFFSCREEN_SCORE") {
    getState().then(async state => {
      state.score = message.score;
      const now = Date.now();
      if (now - lastScorePersistTime >= 500) {
        lastScorePersistTime = now;
        chrome.storage.session.set({ score: message.score });
      }
      if (!state.active || !state.effects) return;
      if (!activeTabResolved) await activeTab();
      if (activeTabId != null) {
        const tabId = activeTabId;
        sendToTab(tabId, { type: "POSTUREFLOW_SCORE", score: message.score, active: true })
          .then(ok => { if (!ok && message.score > 0) hintUnreachableTab(tabId); });
      }
    });
    chrome.runtime.sendMessage({ ...message, type: "POSTUREFLOW_UI_SCORE" }).catch(() => {});
    return false;
  }
  if (message?.type === "POSTUREFLOW_OFFSCREEN_PREVIEW") {
    chrome.runtime.sendMessage({ type: "POSTUREFLOW_UI_PREVIEW", data: message.data, guide: message.guide }).catch(() => {});
    return false;
  }
  if (message?.type === "PAGE_CAMERA_STATE" && message.active) {
    getState().then(state => { if (state.meetingSuspend && state.active) stopDetection("페이지에서 카메라 사용을 감지해 자세 감지를 중지했습니다."); });
    return false;
  }
  if (message?.type === "POSTUREFLOW_CHECK_STATUS") {
    chrome.storage.session.get("isBreakTime").then(({ isBreakTime = false }) => sendResponse({ isBreakTime }));
    return true;
  }
  if (message?.type === "POSTUREFLOW_TIMER_START") {
    startStandingTimer(Number(message.workMinutes), Number(message.breakMinutes)).then(timer => sendResponse({ ok: true, timer }));
    return true;
  }
  if (message?.type === "POSTUREFLOW_TIMER_STOP") {
    stopStandingTimer().then(timer => sendResponse({ ok: true, timer }));
    return true;
  }
  if (message?.type === "POSTUREFLOW_TIMER_PAUSE") {
    pauseStandingTimer().then(timer => sendResponse({ ok: true, timer }));
    return true;
  }
  if (message?.type === "POSTUREFLOW_TIMER_RESUME") {
    resumeStandingTimer().then(timer => sendResponse({ ok: true, timer }));
    return true;
  }
  if (message?.type === "POSTUREFLOW_TIMER_GET") {
    advanceStandingTimer().then(timer => sendResponse(timer));
    return true;
  }
});

async function handleTabChange(tabId) {
  const tab = tabId == null ? await activeTab() : await chrome.tabs.get(tabId).catch(() => null);
  activeTabId = tab?.id ?? null;
  activeTabResolved = true;
  const state = await getState();
  if (!tab) return;
  const timer = await getStandingTimer();
  await sendToTab(tab.id, { type: "POSTUREFLOW_TRAPEZOID_MODE", active: !!timer.active && !!timer.isBreakTime });
  if (!state.active) {
    await sendToTab(tab.id, { type: "POSTUREFLOW_STATE", active: false, reason: "자세 감지가 중지되었습니다." });
    return;
  }
  if (state.meetingSuspend && isMeetingUrl(tab.url)) {
    await stopDetection("회의/화상통화 사이트에서는 자동으로 중지했습니다.");
    return;
  }
  if (state.effects) {
    await sendToTab(tab.id, { type: "POSTUREFLOW_SCORE", score: state.score, active: true });
  } else {
    await sendToTab(tab.id, { type: "POSTUREFLOW_EFFECTS", enabled: false });
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
  activeTabResolved = true;
  handleTabChange(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") unreachableHinted.delete(tabId); // reloaded: content script is live again
  if (tab.active && (changeInfo.url || changeInfo.status === "complete")) {
    activeTabId = tabId;
    activeTabResolved = true;
    handleTabChange(tabId);
  }
});
