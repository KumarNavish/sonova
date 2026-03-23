const FEATURE_COLUMNS = [
  "intelligibility",
  "noise_control",
  "comfort",
  "loudness_stability",
  "speech_prominence",
];

const FEATURE_LABELS = {
  intelligibility: "Word clarity",
  noise_control: "Noise control",
  comfort: "Comfort",
  loudness_stability: "Loudness stability",
  speech_prominence: "Speech focus",
};

const DEFAULT_SCENE = "crowd_social";
const DEFAULT_PRIORITY = 62;
const DEFAULT_FEEDBACK_SCENE = "meeting_room";
const DEFAULT_FEEDBACK_PROFILE = "comfort_softness";
const AB_TOGGLE_MS = 1100;
const SAVED_KEY = "sonova_saved_scene_profiles";

const els = {
  launchBtn: document.getElementById("launch-btn"),
  playABHeroBtn: document.getElementById("play-ab-hero-btn"),
  heroProfile: document.getElementById("hero-profile"),
  heroScene: document.getElementById("hero-scene"),
  pulseBars: document.getElementById("pulse-bars"),

  stepButtons: {
    1: document.getElementById("step-1"),
    2: document.getElementById("step-2"),
    3: document.getElementById("step-3"),
  },
  stages: {
    1: document.getElementById("stage-1"),
    2: document.getElementById("stage-2"),
    3: document.getElementById("stage-3"),
  },

  sceneGrid: document.getElementById("scene-grid"),
  prioritySlider: document.getElementById("priority-slider"),
  priorityValue: document.getElementById("priority-value"),
  generateBtn: document.getElementById("generate-btn"),

  sceneCaption: document.getElementById("scene-caption"),
  winnerName: document.getElementById("winner-name"),
  winnerDesc: document.getElementById("winner-desc"),

  playRawBtn: document.getElementById("play-raw-btn"),
  playAIBtn: document.getElementById("play-ai-btn"),
  playABBtn: document.getElementById("play-ab-btn"),
  stopBtn: document.getElementById("stop-btn"),
  playState: document.getElementById("play-state"),
  stateCopy: document.getElementById("state-copy"),

  metricNoise: document.getElementById("metric-noise"),
  metricSpeech: document.getElementById("metric-speech"),
  metricConfidence: document.getElementById("metric-confidence"),

  rawAudio: document.getElementById("raw-audio"),
  aiAudio: document.getElementById("ai-audio"),

  toStage1Btn: document.getElementById("to-stage-1-btn"),
  toStage2Btn: document.getElementById("to-stage-2-btn"),
  toStage3Btn: document.getElementById("to-stage-3-btn"),

  recommendTitle: document.getElementById("recommend-title"),
  recommendReason: document.getElementById("recommend-reason"),
  recommendAction: document.getElementById("recommend-action"),
  recommendBackup: document.getElementById("recommend-backup"),
  saveSceneBtn: document.getElementById("save-scene-btn"),
  savedBadge: document.getElementById("saved-badge"),
  scoreTable: document.getElementById("score-table"),

  feedbackSceneSelect: document.getElementById("feedback-scene-select"),
  feedbackProfileSelect: document.getElementById("feedback-profile-select"),
  applyFeedbackBtn: document.getElementById("apply-feedback-btn"),
  feedbackSummary: document.getElementById("feedback-summary"),
  feedbackBeforeTable: document.getElementById("feedback-before-table"),
  feedbackAfterTable: document.getElementById("feedback-after-table"),
  stabilityTable: document.getElementById("stability-table"),
};

const state = {
  bundle: null,
  sceneMap: {},
  profileMap: {},
  featuresByScene: {},
  selectedSceneId: null,
  currentStep: 1,
  lastWeightsCfg: null,
  lastScored: null,
  lastWinner: null,
  abTimer: null,
  abNext: "raw",
  abAnchorSec: 1.0,
};

function fmt(value, decimals = 3) {
  return Number(value).toFixed(decimals);
}

function fmtSigned(value, decimals = 1) {
  const v = Number(value);
  return `${v >= 0 ? "+" : ""}${v.toFixed(decimals)}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeWeights(weightObj) {
  const safe = {};
  let total = 0;
  for (const key of Object.keys(weightObj)) {
    safe[key] = Math.max(1e-6, Number(weightObj[key]));
    total += safe[key];
  }

  const normalized = {};
  for (const key of Object.keys(safe)) {
    normalized[key] = safe[key] / total;
  }
  return normalized;
}

function tableHtml(columns, rows) {
  const head = `<tr>${columns.map((c) => `<th>${c.label}</th>`).join("")}</tr>`;
  const body = rows
    .map((row) => `<tr>${columns.map((c) => `<td>${c.render(row)}</td>`).join("")}</tr>`)
    .join("");
  return `<thead>${head}</thead><tbody>${body}</tbody>`;
}

function applyPreferenceTilt(baseWeights, priority) {
  const tilt = (Number(priority) - 50) / 50;
  const tuned = { ...baseWeights };

  tuned.intelligibility += 0.14 * tilt;
  tuned.speech_prominence += 0.1 * tilt;
  tuned.noise_control += 0.06 * tilt;
  tuned.comfort -= 0.1 * tilt;
  tuned.loudness_stability -= 0.05 * tilt;

  return normalizeWeights(tuned);
}

function personalizedWeightsConfig(priority) {
  const cfg = clone(state.bundle.weights);
  for (const scene of state.bundle.scenes) {
    const base = normalizeWeights(state.bundle.weights.scene_weights[scene.id]);
    cfg.scene_weights[scene.id] = applyPreferenceTilt(base, priority);
  }
  return cfg;
}

function computeScore(featureRow, weights) {
  const contributions = {};
  let score = 0;

  for (const feature of FEATURE_COLUMNS) {
    const value = Number(featureRow[feature]);
    const c = Number(weights[feature]) * value;
    contributions[feature] = c;
    score += c;
  }

  return { score, contributions };
}

function scoreScene(sceneId, weightsCfg) {
  const rows = state.featuresByScene[sceneId] || [];
  const weights = normalizeWeights(weightsCfg.scene_weights[sceneId]);

  const scored = rows.map((row) => {
    const { score, contributions } = computeScore(row, weights);
    return {
      scene_id: sceneId,
      profile_id: row.profile_id,
      profile_name: state.profileMap[row.profile_id].name,
      profile_description: state.profileMap[row.profile_id].description,
      audio_path: row.audio_path,
      score,
      contributions,
      ...Object.fromEntries(FEATURE_COLUMNS.map((f) => [f, Number(row[f])])),
    };
  });

  scored.sort((a, b) => b.score - a.score);
  scored.forEach((row, idx) => {
    row.rank = idx + 1;
  });

  return { scored, weights };
}

function scoreAllScenes(weightsCfg) {
  const byScene = {};
  for (const scene of state.bundle.scenes) {
    byScene[scene.id] = scoreScene(scene.id, weightsCfg).scored;
  }
  return byScene;
}

function decisionConfidence(margin) {
  const pct = Math.max(56, Math.min(97, Math.round(57 + 700 * margin)));
  if (margin >= 0.045) {
    return { level: "High", pct };
  }
  if (margin >= 0.02) {
    return { level: "Moderate", pct };
  }
  return { level: "Needs listening check", pct };
}

function topContributions(contributions, topK = 2) {
  return Object.entries(contributions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK);
}

function setStep(step) {
  state.currentStep = step;
  for (const id of [1, 2, 3]) {
    els.stages[id].classList.toggle("is-hidden", id !== step);
    els.stepButtons[id].classList.toggle("is-active", id === step);
  }
}

function setPlayState(text, tone = "neutral") {
  els.playState.className = `status${tone === "good" ? " good" : tone === "warn" ? " warn" : ""}`;
  els.playState.textContent = text;
}

function setPulse(isPlaying) {
  els.pulseBars.classList.toggle("is-playing", Boolean(isPlaying));
}

function stopAudio() {
  if (state.abTimer) {
    clearInterval(state.abTimer);
    state.abTimer = null;
  }
  els.rawAudio.pause();
  els.aiAudio.pause();
  setPulse(false);
  setPlayState("Idle", "neutral");
}

function currentSyncTime() {
  if (!els.rawAudio.paused) {
    return els.rawAudio.currentTime;
  }
  if (!els.aiAudio.paused) {
    return els.aiAudio.currentTime;
  }
  return Math.max(els.rawAudio.currentTime || 0, els.aiAudio.currentTime || 0);
}

async function playSingle(which) {
  if (state.abTimer) {
    clearInterval(state.abTimer);
    state.abTimer = null;
  }

  const src = which === "raw" ? els.rawAudio : els.aiAudio;
  const other = which === "raw" ? els.aiAudio : els.rawAudio;
  other.pause();

  const sync = currentSyncTime();
  try {
    src.currentTime = Math.min(sync, Math.max(0, (src.duration || 0.2) - 0.05));
  } catch {
    src.currentTime = 0;
  }

  try {
    await src.play();
  } catch {
    return;
  }

  setPulse(which === "ai");
  if (which === "raw") {
    setPlayState("Playing raw scene audio", "warn");
  } else {
    setPlayState("Playing AI-enhanced profile", "good");
  }
}

function abStep() {
  const playRaw = state.abNext === "raw";
  const src = playRaw ? els.rawAudio : els.aiAudio;
  const other = playRaw ? els.aiAudio : els.rawAudio;

  other.pause();

  const anchor = Math.min(state.abAnchorSec, Math.max(0.1, (src.duration || 2.0) - 0.1));
  try {
    src.currentTime = anchor;
  } catch {
    src.currentTime = 0;
  }

  src.play().catch(() => {
    stopAudio();
  });

  state.abNext = playRaw ? "ai" : "raw";
  setPulse(!playRaw);
  setPlayState(playRaw ? "A/B: raw" : "A/B: AI", playRaw ? "warn" : "good");
}

function startAB() {
  stopAudio();
  const sync = currentSyncTime();
  state.abAnchorSec = sync > 0.35 ? sync : 1.0;
  state.abNext = "raw";
  abStep();
  state.abTimer = setInterval(abStep, AB_TOGGLE_MS);
}

function renderSceneCards() {
  els.sceneGrid.innerHTML = "";
  for (const scene of state.bundle.scenes) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `scene-card${scene.id === state.selectedSceneId ? " is-active" : ""}`;
    btn.innerHTML = `<span class="name">${scene.label}</span><span class="desc">${scene.description}</span>`;
    btn.addEventListener("click", () => {
      if (scene.id === state.selectedSceneId) {
        return;
      }
      state.selectedSceneId = scene.id;
      renderSceneCards();
      runRecommendation(false);
      renderSavedState();
    });
    els.sceneGrid.appendChild(btn);
  }
}

function renderMetric(el, label, value, hint, tone = "good") {
  el.className = `metric ${tone}`;
  el.innerHTML = `
    <span class="label">${label}</span>
    <span class="value">${value}</span>
    <span class="hint">${hint}</span>
  `;
}

function renderScoreTable(scored) {
  const columns = [
    { label: "Rank", render: (r) => r.rank },
    { label: "Profile", render: (r) => r.profile_name },
    { label: "Utility", render: (r) => fmt(r.score) },
    ...FEATURE_COLUMNS.map((f) => ({ label: FEATURE_LABELS[f], render: (r) => fmt(r[f]) })),
  ];
  els.scoreTable.innerHTML = tableHtml(columns, scored);
}

function renderRecommendationCards(scene, winner, runner, margin, conf, weights) {
  const topEvidence = topContributions(winner.contributions, 2)
    .map(([feature]) => FEATURE_LABELS[feature])
    .join(" + ");

  const prioritySummary = Object.entries(weights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([feature, weight]) => `${FEATURE_LABELS[feature]} (${fmt(weight, 2)})`)
    .join(", ");

  const momentLabel = state.bundle.scene_moments?.[scene.id] || scene.label;

  els.recommendTitle.innerHTML = `
    <h3>${winner.profile_name}</h3>
    <p>Best match for <b>${scene.label}</b></p>
    <p>Moment: ${momentLabel}</p>
  `;

  els.recommendReason.innerHTML = `
    <h3>Why it wins</h3>
    <p>Top evidence: <b>${topEvidence}</b>.</p>
    <p>Scene weighting: ${prioritySummary}.</p>
  `;

  els.recommendAction.innerHTML = `
    <h3>Use now</h3>
    <p>Start with <b>${winner.profile_name}</b>.</p>
    <p>If needed, switch to <b>${runner.profile_name}</b>.</p>
  `;

  els.recommendBackup.innerHTML = `
    <b>Decision confidence:</b> ${conf.pct}% (${conf.level}) · utility margin ${fmt(margin)}.
  `;
}

function runRecommendation(moveToHearStage) {
  const scene = state.sceneMap[state.selectedSceneId];
  const priority = Number(els.prioritySlider.value);

  const weightsCfg = personalizedWeightsConfig(priority);
  const { scored, weights } = scoreScene(scene.id, weightsCfg);
  const winner = scored[0];
  const runner = scored[1];
  const margin = winner.score - runner.score;
  const conf = decisionConfidence(margin);

  state.lastWeightsCfg = weightsCfg;
  state.lastWinner = winner;
  state.lastScored = scored;

  stopAudio();
  els.rawAudio.src = scene.audio.noisy;
  els.aiAudio.src = winner.audio_path;

  els.heroProfile.textContent = winner.profile_name;
  els.heroScene.textContent = `for ${scene.label}`;

  els.sceneCaption.textContent = `Scene: ${scene.label}. Compare the same timestamp to hear the AI lift.`;
  els.winnerName.textContent = winner.profile_name;
  els.winnerDesc.textContent = winner.profile_description;

  const metrics = state.bundle.audio_metrics?.[scene.id]?.[winner.profile_id] || {
    noise_floor_drop_db: 0,
    speech_band_shift_db: 0,
    speech_focus_delta_pct: 0,
  };

  const noise = Number(metrics.noise_floor_drop_db);
  const speech = Number(metrics.speech_band_shift_db);
  const focusShift = Number(metrics.speech_focus_delta_pct);

  renderMetric(
    els.metricNoise,
    noise >= 0 ? "Background reduction" : "Ambience retained",
    `${fmtSigned(noise, 1)} dB`,
    noise >= 0 ? "Lower background floor" : "Natural ambience preserved",
    noise >= 0 ? "good" : "warn",
  );

  renderMetric(
    els.metricSpeech,
    "Speech presence",
    `${fmtSigned(speech, 1)} dB`,
    `Speech band lift, focus shift ${fmtSigned(focusShift, 1)} pts`,
    speech >= 0 ? "good" : "warn",
  );

  renderMetric(
    els.metricConfidence,
    "Decision confidence",
    `${conf.pct}%`,
    `Utility margin ${fmt(margin)} in this scene`,
    conf.level === "Needs listening check" ? "warn" : "good",
  );

  els.stateCopy.textContent =
    conf.level === "Needs listening check"
      ? "Close scores: use Smart A/B before locking your choice."
      : "Smart A/B is locked to one timestamp so differences are easy to hear.";

  renderRecommendationCards(scene, winner, runner, margin, conf, weights);
  renderScoreTable(scored);

  if (moveToHearStage) {
    setStep(2);
  }
}

function getSavedMap() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || "{}");
  } catch {
    return {};
  }
}

function renderSavedState() {
  const saved = getSavedMap()[state.selectedSceneId];
  if (!saved) {
    els.savedBadge.classList.add("is-hidden");
    els.savedBadge.textContent = "";
    return;
  }

  els.savedBadge.classList.remove("is-hidden");
  els.savedBadge.textContent = `Saved: ${saved.profile_name} for ${saved.scene_label}`;
}

function saveCurrentSceneSetting() {
  if (!state.lastWinner || !state.selectedSceneId) {
    return;
  }

  const scene = state.sceneMap[state.selectedSceneId];
  const saved = getSavedMap();
  saved[state.selectedSceneId] = {
    profile_id: state.lastWinner.profile_id,
    profile_name: state.lastWinner.profile_name,
    scene_label: scene.label,
    ts: new Date().toISOString(),
  };
  localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
  renderSavedState();
}

function applyLocalPreferenceUpdate(weightsCfg, targetScene, preferredProfile) {
  const updatedCfg = clone(weightsCfg);
  const rule = state.bundle.weights.update_rule;

  const sceneRows = state.featuresByScene[targetScene];
  const scoresBefore = scoreAllScenes(weightsCfg);
  const sceneBefore = [...scoresBefore[targetScene]];
  const currentWinner = sceneBefore[0].profile_id;

  const winnerFeatures = sceneRows.find((row) => row.profile_id === currentWinner);
  const preferredFeatures = sceneRows.find((row) => row.profile_id === preferredProfile);

  const oldWeights = normalizeWeights(weightsCfg.scene_weights[targetScene]);
  const oldVec = FEATURE_COLUMNS.map((f) => oldWeights[f]);
  const deltaFeatures = FEATURE_COLUMNS.map((f) => Number(preferredFeatures[f]) - Number(winnerFeatures[f]));

  const lr = Number(rule.learning_rate);
  const maxShift = Number(rule.max_feature_weight_shift);
  const reg = Number(rule.regularization_to_old_weights);

  const proposed = oldVec.map((v, i) => v + lr * deltaFeatures[i]);
  const clipped = proposed.map((v, i) => Math.min(oldVec[i] + maxShift, Math.max(oldVec[i] - maxShift, v)));
  const updated = clipped.map((v, i) => (1 - reg) * v + reg * oldVec[i]);

  const newWeightObj = {};
  FEATURE_COLUMNS.forEach((feature, i) => {
    newWeightObj[feature] = Math.max(1e-6, updated[i]);
  });
  updatedCfg.scene_weights[targetScene] = normalizeWeights(newWeightObj);

  const scoresAfter = scoreAllScenes(updatedCfg);
  const sceneAfter = [...scoresAfter[targetScene]];

  let maxNonTargetShift = 0;
  const stabilityRows = [];

  for (const scene of state.bundle.scenes) {
    if (scene.id === targetScene) {
      continue;
    }

    const beforeRows = scoresBefore[scene.id];
    const afterRows = scoresAfter[scene.id];

    const beforeWinner = beforeRows[0].profile_id;
    const afterWinner = afterRows[0].profile_id;

    let localMax = 0;
    for (const before of beforeRows) {
      const after = afterRows.find((row) => row.profile_id === before.profile_id);
      localMax = Math.max(localMax, Math.abs(after.score - before.score));
    }

    maxNonTargetShift = Math.max(maxNonTargetShift, localMax);

    stabilityRows.push({
      scene: state.sceneMap[scene.id].label,
      winner_before: state.profileMap[beforeWinner].name,
      winner_after: state.profileMap[afterWinner].name,
      status: beforeWinner === afterWinner ? "Stable" : "Changed",
      abs_shift: localMax,
    });
  }

  return {
    diagnostics: {
      winner_before: sceneBefore[0].profile_id,
      winner_after: sceneAfter[0].profile_id,
      max_non_target_abs_score_shift: maxNonTargetShift,
      threshold: Number(rule.non_target_max_abs_score_shift_threshold),
    },
    sceneBefore,
    sceneAfter,
    stabilityRows,
  };
}

function renderFeedback() {
  const targetScene = els.feedbackSceneSelect.value;
  const preferredProfile = els.feedbackProfileSelect.value;
  const weightsCfg = state.lastWeightsCfg || personalizedWeightsConfig(els.prioritySlider.value);

  const update = applyLocalPreferenceUpdate(weightsCfg, targetScene, preferredProfile);

  const cols = [
    { label: "Profile", render: (r) => state.profileMap[r.profile_id].name },
    { label: "Score", render: (r) => fmt(r.score) },
    { label: "Rank", render: (r) => r.rank },
  ];
  els.feedbackBeforeTable.innerHTML = tableHtml(cols, update.sceneBefore);
  els.feedbackAfterTable.innerHTML = tableHtml(cols, update.sceneAfter);

  const stabilityCols = [
    { label: "Scene", render: (r) => r.scene },
    { label: "Winner before", render: (r) => r.winner_before },
    { label: "Winner after", render: (r) => r.winner_after },
    { label: "Status", render: (r) => r.status },
    { label: "Max abs shift", render: (r) => fmt(r.abs_shift, 5) },
  ];
  els.stabilityTable.innerHTML = tableHtml(stabilityCols, update.stabilityRows);

  const beforeWinner = state.profileMap[update.diagnostics.winner_before].name;
  const afterWinner = state.profileMap[update.diagnostics.winner_after].name;
  const changed = beforeWinner !== afterWinner;
  const stable = update.diagnostics.max_non_target_abs_score_shift <= update.diagnostics.threshold;

  els.feedbackSummary.innerHTML = `
    <p><b>Target scene:</b> ${state.sceneMap[targetScene].label}</p>
    <p><b>Preferred profile:</b> ${state.profileMap[preferredProfile].name}</p>
    <p><b>Winner:</b> ${beforeWinner} → ${afterWinner} (${changed ? "changed" : "unchanged"})</p>
    <p><b>Non-target drift:</b> ${fmt(update.diagnostics.max_non_target_abs_score_shift, 5)} / ${fmt(update.diagnostics.threshold, 5)} (${stable ? "PASS" : "FAIL"})</p>
  `;
}

function initSelects() {
  els.feedbackSceneSelect.innerHTML = "";
  els.feedbackProfileSelect.innerHTML = "";

  for (const scene of state.bundle.scenes) {
    const option = document.createElement("option");
    option.value = scene.id;
    option.textContent = scene.label;
    els.feedbackSceneSelect.appendChild(option);
  }

  for (const profile of state.bundle.profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    els.feedbackProfileSelect.appendChild(option);
  }

  const sceneIds = new Set(state.bundle.scenes.map((s) => s.id));
  state.selectedSceneId = sceneIds.has(DEFAULT_SCENE) ? DEFAULT_SCENE : state.bundle.scenes[0].id;
  els.feedbackSceneSelect.value = sceneIds.has(DEFAULT_FEEDBACK_SCENE) ? DEFAULT_FEEDBACK_SCENE : state.selectedSceneId;
  els.feedbackProfileSelect.value = state.profileMap[DEFAULT_FEEDBACK_PROFILE] ? DEFAULT_FEEDBACK_PROFILE : state.bundle.profiles[0].id;
  els.prioritySlider.value = String(DEFAULT_PRIORITY);
  els.priorityValue.textContent = String(DEFAULT_PRIORITY);
}

async function loadBundle() {
  const response = await fetch("./data/bundle.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load bundle.json (${response.status})`);
  }

  const bundle = await response.json();
  state.bundle = bundle;

  for (const scene of bundle.scenes) {
    state.sceneMap[scene.id] = scene;
  }

  for (const profile of bundle.profiles) {
    state.profileMap[profile.id] = profile;
  }

  for (const row of bundle.features) {
    if (!state.featuresByScene[row.scene_id]) {
      state.featuresByScene[row.scene_id] = [];
    }
    state.featuresByScene[row.scene_id].push(row);
  }
}

function wireEvents() {
  els.launchBtn.addEventListener("click", () => {
    runRecommendation(true);
    startAB();
    renderFeedback();
    document.getElementById("demo").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  els.playABHeroBtn.addEventListener("click", () => {
    runRecommendation(true);
    startAB();
    document.getElementById("demo").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  els.generateBtn.addEventListener("click", () => {
    runRecommendation(true);
    renderFeedback();
  });

  els.prioritySlider.addEventListener("input", () => {
    els.priorityValue.textContent = String(els.prioritySlider.value);
    runRecommendation(false);
  });

  els.playRawBtn.addEventListener("click", () => playSingle("raw"));
  els.playAIBtn.addEventListener("click", () => playSingle("ai"));
  els.playABBtn.addEventListener("click", () => startAB());
  els.stopBtn.addEventListener("click", () => stopAudio());

  els.toStage1Btn.addEventListener("click", () => {
    stopAudio();
    setStep(1);
  });
  els.toStage2Btn.addEventListener("click", () => setStep(2));
  els.toStage3Btn.addEventListener("click", () => {
    setStep(3);
    renderSavedState();
  });

  els.stepButtons[1].addEventListener("click", () => setStep(1));
  els.stepButtons[2].addEventListener("click", () => setStep(2));
  els.stepButtons[3].addEventListener("click", () => setStep(3));

  els.saveSceneBtn.addEventListener("click", () => saveCurrentSceneSetting());
  els.applyFeedbackBtn.addEventListener("click", () => renderFeedback());
}

async function init() {
  try {
    await loadBundle();
    initSelects();
    renderSceneCards();
    wireEvents();

    setStep(1);
    runRecommendation(false);
    renderFeedback();
    renderSavedState();
  } catch (error) {
    document.body.innerHTML = `<main class="page"><section class="panel" style="padding:16px;"><h2>Failed to load demo</h2><p>${String(error)}</p></section></main>`;
  }
}

init();
