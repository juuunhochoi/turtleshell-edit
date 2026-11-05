import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

const video = document.getElementById("camera");
let stream = null;
let landmarker = null;
let frameCallback = 0;
let fallbackTimer = null;
let baseline = null;
let smoothedScore = 0;
let unscorableSince = 0;
let headTurnSuppressed = false;
let headRollSuppressed = false;
let torsoTurnSuppressed = false;
let lastVideoTime = -1;
let lastPreviewTime = 0;
let previewInFlight = false;
let previewGeneration = 0;
let lastLandmarkerTimestamp = 0;
let lastScorePublishTime = 0;
let lastInferenceTime = 0;
let silhouetteOnlyPreview = false;
const previewCanvas = document.createElement("canvas");
previewCanvas.width = 320;
previewCanvas.height = 240;
const previewContext = previewCanvas.getContext("2d");

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const BLUR_START_SCORE = 0.8;
const BLUR_PEAK_SCORE = 2.0;

function extractFeatures(landmarks, worldLandmarks) {
  const nose = landmarks[0];
  const leftEar = landmarks[7], rightEar = landmarks[8];
  const leftShoulder = landmarks[11], rightShoulder = landmarks[12];
  const isVisible = point => point && point.visibility > 0.35;
  const faceVisible = [nose, leftEar, rightEar].filter(isVisible).length;
  if (!faceVisible && !isVisible(leftShoulder) && !isVisible(rightShoulder)) {
    return { valid: false, missing: true, reason: "얼굴 또는 어깨 랜드마크가 보이지 않음" };
  }
  // Face partly hidden (hand, headphones): hold the current score briefly instead of resetting it.
  if (faceVisible < 3) return { valid: false, graceMs: 1500, reason: "얼굴 일부가 가려져 측정 보류" };
  // A hidden shoulder is often the slouch itself (sinking below the frame), so keep scoring
  // with the model's estimated shoulder position rather than pausing.
  // ponytail: estimate quality off-frame is unverified; add an explicit penalty if it under-reports.
  if (!leftShoulder || !rightShoulder) return { valid: false, missing: true, reason: "어깨 랜드마크 없음" };

  const earMidX = (leftEar.x + rightEar.x) / 2;
  const earWidth = Math.max(0.02, Math.abs(leftEar.x - rightEar.x));
  const shoulderWidth2d = Math.max(0.05, Math.abs(leftShoulder.x - rightShoulder.x));
  const shoulderMidX = (leftShoulder.x + rightShoulder.x) / 2;
  const shoulderMidY = (leftShoulder.y + rightShoulder.y) / 2;

  // Turning the head or torso makes the apparent head/shoulder geometry unreliable.
  const headTurn = Math.abs(nose.x - earMidX) / earWidth;
  const world = worldLandmarks;
  const worldPoints = [world?.[11], world?.[12]];
  if (!worldPoints.every(point =>
    point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)
  )) return { valid: false, reason: "깊이 좌표 없음", headTurn };

  const [leftShoulder3d, rightShoulder3d] = worldPoints;
  const shoulderDx = leftShoulder3d.x - rightShoulder3d.x;
  const shoulderDy = leftShoulder3d.y - rightShoulder3d.y;
  const shoulderDz = leftShoulder3d.z - rightShoulder3d.z;
  const shoulderWidth3d = Math.max(0.15, Math.hypot(shoulderDx, shoulderDy, shoulderDz));
  const torsoTurn = Math.abs(shoulderDz) / shoulderWidth3d;
  const headRoll = Math.atan2(rightEar.y - leftEar.y, Math.abs(rightEar.x - leftEar.x));
  const earMidY = (leftEar.y + rightEar.y) / 2;
  const pose = [
    { x: (earMidX - shoulderMidX) / shoulderWidth2d, y: (earMidY - shoulderMidY) / shoulderWidth2d }
  ];
  return { valid: true, reason: "측정 중", headTurn, headRoll, torsoTurn, pose };
}

function measurePoseDeviation(currentPose, baselinePose) {
  const weights = [1];
  let weightedSquaredDistance = 0;
  let totalWeight = 0;
  for (let index = 0; index < Math.min(currentPose?.length || 0, baselinePose?.length || 0); index++) {
    const current = currentPose[index], reference = baselinePose[index];
    if (!current || !reference) continue;
    const dx = current.x - reference.x;
    const dy = current.y - reference.y;
    const weight = weights[index] ?? 1;
    weightedSquaredDistance += weight * (dx * dx + dy * dy);
    totalWeight += weight;
  }
  return totalWeight ? Math.sqrt(weightedSquaredDistance / totalWeight) : 0;
}

function measureOrientation(features, reference) {
  const rollDeviation = Math.abs(features.headRoll - reference.headRoll);
  headTurnSuppressed = headTurnSuppressed ? features.headTurn > 0.34 : features.headTurn > 0.42;
  headRollSuppressed = headRollSuppressed ? rollDeviation > 0.18 : rollDeviation > 0.28;
  torsoTurnSuppressed = torsoTurnSuppressed ? features.torsoTurn > 0.35 : features.torsoTurn > 0.45;

  const headTurnWeight = clamp((0.52 - features.headTurn) / 0.18, 0, 1);
  const headRollWeight = clamp((0.38 - rollDeviation) / 0.20, 0, 1);
  const torsoTurnWeight = clamp((0.62 - features.torsoTurn) / 0.25, 0, 1);
  return {
    suppressed: headTurnSuppressed || headRollSuppressed || torsoTurnSuppressed,
    weight: headTurnWeight * headRollWeight * torsoTurnWeight,
    reason: headTurnSuppressed ? "정면을 바라보면 측정을 재개합니다."
      : headRollSuppressed ? "고개를 좌우로 기울이지 않으면 측정을 재개합니다."
        : "몸을 정면으로 두면 측정을 재개합니다."
  };
}

function drawPreview(result) {
  if (!previewContext) return;
  const width = previewCanvas.width, height = previewCanvas.height;
  if (silhouetteOnlyPreview) {
    previewContext.fillStyle = "#e5e7eb";
    previewContext.fillRect(0, 0, width, height);
  } else {
    previewContext.drawImage(video, 0, 0, width, height);
  }
  const segmentationMask = result?.segmentationMasks?.[0];
  if (segmentationMask && silhouetteContext) {
    const maskWidth = segmentationMask.width, maskHeight = segmentationMask.height;
    const maskValues = segmentationMask.getAsFloat32Array();
    const colorStops = smoothedScore < BLUR_START_SCORE
      ? { from: [56, 189, 248], to: [249, 115, 22], progress: clamp(smoothedScore / BLUR_START_SCORE, 0, 1) }
      : { from: [249, 115, 22], to: [239, 68, 68], progress: clamp((smoothedScore - BLUR_START_SCORE) / (BLUR_PEAK_SCORE - BLUR_START_SCORE), 0, 1) };
    const silhouetteColor = colorStops.from.map((channel, index) =>
      Math.round(channel + (colorStops.to[index] - channel) * colorStops.progress)
    );
    if (!silhouetteImageData || silhouetteCanvas.width !== maskWidth || silhouetteCanvas.height !== maskHeight) {
      silhouetteCanvas.width = maskWidth;
      silhouetteCanvas.height = maskHeight;
      silhouetteImageData = silhouetteContext.createImageData(maskWidth, maskHeight);
    }
    const pixels = silhouetteImageData.data;
    for (let index = 0; index < maskValues.length; index++) {
      const coverage = clamp((maskValues[index] - 0.18) / 0.55, 0, 1);
      const offset = index * 4;
      pixels[offset] = silhouetteColor[0];
      pixels[offset + 1] = silhouetteColor[1];
      pixels[offset + 2] = silhouetteColor[2];
      pixels[offset + 3] = Math.round(coverage * 105);
    }
    silhouetteContext.putImageData(silhouetteImageData, 0, 0);
    previewContext.drawImage(silhouetteCanvas, 0, 0, width, height);
  }
  // Setup dots only until a baseline is saved; the silhouette above stays as score feedback.
  if (baseline) return;
  const landmarks = result?.landmarks?.[0];
  const aligned = isAligned(landmarks); // dots turn green once the user sits centred
  const drawPoint = (index, color) => {
    const point = landmarks?.[index];
    if (!point || point.visibility <= 0.2) return;
    previewContext.beginPath();
    previewContext.arc(point.x * width, point.y * height, 4, 0, Math.PI * 2);
    previewContext.fillStyle = color;
    previewContext.fill();
    previewContext.strokeStyle = "#fff";
    previewContext.lineWidth = 1.5;
    previewContext.stroke();
  };
  [7, 8].forEach(index => drawPoint(index, aligned ? "#22c55e" : "#38bdf8"));
  [11, 12].forEach(index => drawPoint(index, aligned ? "#22c55e" : "#fbbf24"));
}

// Setup check: nose centred, shoulders low in frame and a reasonable size (head-and-shoulders framing).
function isAligned(landmarks) {
  const nose = landmarks?.[0], left = landmarks?.[11], right = landmarks?.[12];
  if (!nose || !left || !right || Math.min(nose.visibility, left.visibility, right.visibility) < 0.5) return false;
  const shoulderY = (left.y + right.y) / 2, shoulderWidth = Math.abs(left.x - right.x);
  return Math.abs(nose.x - 0.5) < 0.08 && shoulderY > 0.68 && shoulderY < 0.95 && shoulderWidth > 0.32 && shoulderWidth < 0.62;
}

function sendPreview(result, features) {
  if (performance.now() - lastPreviewTime < 100 || !previewContext || previewInFlight) return;
  lastPreviewTime = performance.now();
  drawPreview(result);
  const guide = baseline ? null : isAligned(result?.landmarks?.[0]);
  previewInFlight = true;
  const generation = previewGeneration;
  previewCanvas.toBlob(blob => {
    if (generation !== previewGeneration) return;
    if (!blob || !stream) {
      previewInFlight = false;
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      if (generation !== previewGeneration) return;
      previewInFlight = false;
      if (stream && typeof reader.result === "string") {
        chrome.runtime.sendMessage({ type: "POSTUREFLOW_OFFSCREEN_PREVIEW", data: reader.result, guide }).catch(() => {});
      }
    };
    reader.onerror = () => {
      if (generation === previewGeneration) previewInFlight = false;
    };
    reader.readAsDataURL(blob);
  }, "image/jpeg", 0.5);
}

function detectCurrentVideoFrame() {
  const timestamp = Math.max(performance.now(), lastLandmarkerTimestamp + 1);
  lastLandmarkerTimestamp = timestamp;
  return landmarker.detectForVideo(video, timestamp);
}

async function createLandmarker() {
  if (landmarker) return landmarker;
  const vision = await FilesetResolver.forVisionTasks(chrome.runtime.getURL("assets/wasm"));
  landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: chrome.runtime.getURL("models/pose_landmarker_lite.task"), delegate: "CPU" },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.55,
    minTrackingConfidence: 0.55
  });
  return landmarker;
}

async function reportStatus(active, title, detail) {
  await chrome.runtime.sendMessage({ type: "POSTUREFLOW_OFFSCREEN_STATUS", active, title, detail }).catch(() => {});
}

function stopTracks() {
  previewGeneration++;
  previewInFlight = false;
  lastPreviewTime = 0;
  if (frameCallback && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameCallback);
  if (fallbackTimer) clearTimeout(fallbackTimer);
  frameCallback = 0;
  fallbackTimer = null;
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  chrome.runtime.sendMessage({ type: "POSTUREFLOW_OFFSCREEN_PREVIEW", data: "" }).catch(() => {});
  baseline = null;
  smoothedScore = 0;
  unscorableSince = 0;
  headTurnSuppressed = false;
  headRollSuppressed = false;
  torsoTurnSuppressed = false;
  lastVideoTime = -1;
  lastInferenceTime = 0;
}

async function stopDetection(reason = "자세 감지를 중지했습니다.") {
  stopTracks();
  await reportStatus(false, "카메라 꺼짐", reason);
}

async function startDetection(cameraId, silhouetteOnly = false) {
  stopTracks();
  silhouetteOnlyPreview = !!silhouetteOnly;
  await reportStatus(true, "카메라 연결 중…", "카메라를 여는 중입니다.");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: cameraId ? { exact: cameraId } : undefined, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    await createLandmarker();
    await reportStatus(true, "자세 감지 중", "기준 자세를 설정해 주세요.");
    scheduleFrame();
  } catch (error) {
    stopTracks();
    const names = {
      NotAllowedError: "카메라 권한이 거부되었습니다.",
      NotFoundError: "선택한 카메라를 찾지 못했습니다.",
      NotReadableError: "선택한 카메라를 열 수 없습니다.",
      OverconstrainedError: "선택한 카메라를 사용할 수 없습니다. 카메라 목록에서 다시 선택해 주세요."
    };
    await reportStatus(false, "카메라 시작 실패", `${names[error?.name] || "카메라 또는 모델을 확인해 주세요."} [${error?.name || "UnknownError"}: ${error?.message || "-"}]`);
  }
}

function scheduleFrame() {
  if (!stream) return;
  let handled = false;
  const run = (timestamp) => {
    if (handled) return;
    handled = true;
    if (frameCallback && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameCallback);
    if (fallbackTimer) clearTimeout(fallbackTimer);
    frameCallback = 0;
    fallbackTimer = null;
    try {
      processFrame();
    } catch (error) {
      chrome.runtime.sendMessage({
        type: "POSTUREFLOW_UI_HINT",
        hint: `프레임 분석 오류: ${error?.message || "알 수 없는 오류"}`
      }).catch(() => {});
    } finally {
      scheduleFrame();
    }
  };
  if (video.requestVideoFrameCallback) {
    frameCallback = video.requestVideoFrameCallback(run);
  }
  // Offscreen documents can pause animation callbacks; the timer keeps scoring and preview alive.
  fallbackTimer = setTimeout(() => run(performance.now()), 80);
}

function processFrame() {
  if (!stream) return;
  if (video.currentTime !== lastVideoTime && video.readyState >= 2) {
    lastVideoTime = video.currentTime;
    const now = performance.now();
    if (now - lastInferenceTime < 80) return;
    lastInferenceTime = now;
    const result = detectCurrentVideoFrame();
    const features = result.landmarks?.[0]
      ? extractFeatures(result.landmarks[0], result.worldLandmarks?.[0])
      : null;
    const orientation = features?.valid && baseline ? measureOrientation(features, baseline) : null;
    if (features?.valid && baseline && !orientation.suppressed) {
      unscorableSince = 0;
      const poseDeviation = measurePoseDeviation(features.pose, baseline.pose) * orientation.weight;
      const rawScore = clamp(((poseDeviation - 0.025) / 0.10) * 10, 0, 10);
      smoothedScore = smoothedScore * 0.65 + rawScore * 0.35;
      const progress = clamp((smoothedScore - BLUR_START_SCORE) / (BLUR_PEAK_SCORE - BLUR_START_SCORE), 0, 1);
      const intensity = progress * progress * (3 - 2 * progress);
      if (performance.now() - lastScorePublishTime >= 80) {
        lastScorePublishTime = performance.now();
        chrome.runtime.sendMessage({
          type: "POSTUREFLOW_OFFSCREEN_SCORE",
          score: intensity,
          displayScore: smoothedScore,
          hint: smoothedScore > 7 ? "자세가 기준에서 많이 벗어났습니다. 자세를 곧게 펴주세요!" : smoothedScore > 3 ? "자세 변화를 감지했습니다." : "좋습니다. 편안한 중립 자세를 유지하고 있어요."
        }).catch(() => {});
      }
    } else if (baseline && ((features && !features.valid && !features.missing) || orientation?.suppressed)) {
      if (!unscorableSince) unscorableSince = performance.now();
      const invalidFor = performance.now() - unscorableSince;
      if (invalidFor >= (features.graceMs ?? 400) && smoothedScore > 0) {
        smoothedScore = 0;
        lastScorePublishTime = performance.now();
        chrome.runtime.sendMessage({
          type: "POSTUREFLOW_OFFSCREEN_SCORE",
          score: 0,
          displayScore: 0,
          hint: orientation?.reason || "얼굴과 어깨가 잘 보이면 측정을 재개합니다."
        }).catch(() => {});
      }
    } else if ((!features || features.missing) && baseline) {
      unscorableSince = 0;
      smoothedScore = 0;
      if (performance.now() - lastScorePublishTime >= 200) {
        lastScorePublishTime = performance.now();
        chrome.runtime.sendMessage({
          type: "POSTUREFLOW_OFFSCREEN_SCORE",
          score: 0,
          displayScore: 0,
          hint: "사람을 찾을 수 없어 자세 점수를 초기화했습니다. 카메라 안으로 돌아와 주세요."
        }).catch(() => {});
      }
    }
    sendPreview(result, features);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "POSTUREFLOW_OFFSCREEN_START") startDetection(message.cameraId, message.silhouetteOnlyPreview);
  if (message?.type === "POSTUREFLOW_OFFSCREEN_STOP") stopDetection(message.reason);
  if (message?.type === "POSTUREFLOW_OFFSCREEN_PREVIEW_MODE") silhouetteOnlyPreview = !!message.silhouetteOnly;
  if (message?.type === "POSTUREFLOW_OFFSCREEN_CALIBRATE") {
    if (!stream || !landmarker) return;
    const result = detectCurrentVideoFrame();
    const features = result.landmarks?.[0]
      ? extractFeatures(result.landmarks[0], result.worldLandmarks?.[0])
      : null;
    if (!features?.valid) {
      chrome.runtime.sendMessage({ type: "POSTUREFLOW_UI_HINT", hint: "얼굴과 어깨가 잘 보이는 상태로 기준 자세를 설정해 주세요." }).catch(() => {});
      return;
    }
    baseline = features;
    smoothedScore = 0;
    unscorableSince = 0;
    headTurnSuppressed = false;
    headRollSuppressed = false;
    torsoTurnSuppressed = false;
    if (features.headTurn > 0.42 || Math.abs(features.headRoll) > 0.28 || features.torsoTurn > 0.45) {
      chrome.runtime.sendMessage({ type: "POSTUREFLOW_UI_HINT", hint: "정면을 보고 고개를 기울이지 않은 자세로 기준을 설정해 주세요." }).catch(() => {});
      baseline = null;
      return;
    }
    chrome.runtime.sendMessage({ type: "POSTUREFLOW_UI_CALIBRATED" }).catch(() => {});
  }
});
