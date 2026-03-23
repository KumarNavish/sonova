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
const DEFAULT_GOAL = "Hear speech clearly in noise";
const DEFAULT_FEEDBACK_SCENE = "meeting_room";
const DEFAULT_FEEDBACK_PROFILE = "comfort_softness";
const AB_TOGGLE_MS = 1050;
const SAVED_KEY = "sonova_saved_scene_profiles";

const els = {
  heroStartBtn: document.getElementById("hero-start-btn"),
  stepBtns: {
    1: document.getElementById("step-btn-1"),
    2: document.getElementById("step-btn-2"),
    3: document.getElementById("step-btn-3"),
  },
  screens: {
    1: document.getElementById("screen-1"),
    2: document.getElementById("screen-2"),
    3: document.getElementById("screen-3"),
  },

  sceneCards: document.getElementById("scene-cards"),
  goalChips: document.getElementById("goal-chips"),
  goalCoach: document.getElementById("goal-coach"),

  clarity: document.getElementById("clarity-slider"),
  noise: document.getElementById("noise-slider"),
  comfort: document.getElementById("comfort-slider"),
  clarityValue: document.getElementById("clarity-value"),
  noiseValue: document.getElementById("noise-value"),
  comfortValue: document.getElementById("comfort-value"),

  toStep2Btn: document.getElementById("to-step-2-btn"),
  backTo1Btn: document.getElementById("back-to-1-btn"),
  toStep3Btn: document.getElementById("to-step-3-btn"),
  backTo2Btn: document.getElementById("back-to-2-btn"),

  compareCaption: document.getElementById("compare-caption"),
  winnerHero: document.getElementById("winner-hero"),
  playBeforeBtn: document.getElementById("play-before-btn"),
  playAfterBtn: document.getElementById("play-after-btn"),
  playABBtn: document.getElementById("play-ab-btn"),
  stopBtn: document.getElementById("stop-btn"),
  playState: document.getElementById("play-state"),
  beforeAudio: document.getElementById("before-audio"),
  afterAudio: document.getElementById("after-audio"),

  impactA: document.getElementById("impact-a"),
  impactB: document.getElementById("impact-b"),
  impactC: document.getElementById("impact-c"),

  winnerCard: document.getElementById("winner-card"),
  confidenceCard: document.getElementById("confidence-card"),
  actionCard: document.getElementById("action-card"),
  scoreTable: document.getElementById("score-table"),
  saveSettingBtn: document.getElementById("save-setting-btn"),
  savedNote: document.getElementById("saved-note"),

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
  selectedGoal: DEFAULT_GOAL,
  currentStep: 1,
  lastWeightsCfg: null,
  lastWinner: null,
  abTimer: null,
  abNext: "before",
};

function fmt(value, decimals = 3) {
  return Number(value).toFixed(decimals);
}

function fmtSigned(value, decimals = 1) {
  const v = Number(value);
  return `${v >= 0 ? "+" : ""}${v.toFixed(decimals)}`;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function normalizeWeights(weightObj) {
  const safe = {};
  let total = 0;
  for (const key of Object.keys(weightObj)) {
    safe[key] = Math.max(1e-6, Number(weightObj[key]));
    total += safe[key];
  }
  const out = {};
  for (const key of Object.keys(safe)) {
    out[key] = safe[key] / total;
  }
  return out;
}

function applyUserTilt(baseWeights, clarity, noise, comfort) {
  const clarityShift = (Number(clarity) - 50.0) / 50.0;
  const noiseShift = (Number(noise) - 50.0) / 50.0;
  const comfortShift = (Number(comfort) - 50.0) / 50.0;

  const tuned = { ...baseWeights };
  tuned.intelligibility += 0.1 * clarityShift;
  tuned.speech_prominence += 0.06 * clarityShift;

  tuned.noise_control += 0.12 * noiseShift;
  tuned.speech_prominence += 0.03 * noiseShift;

  tuned.comfort += 0.11 * comfortShift;
  tuned.loudness_stability += 0.08 * comfortShift;

  return normalizeWeights(tuned);
}

function personalizedWeightsConfig(clarity, noise, comfort) {
  const cfg = clone(state.bundle.weights);
  for (const scene of state.bundle.scenes) {
    const base = normalizeWeights(state.bundle.weights.scene_weights[scene.id]);
    cfg.scene_weights[scene.id] = applyUserTilt(base, clarity, noise, comfort);
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
  scored.forEach((row, i) => {
    row.rank = i + 1;
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
  const pct = Math.max(55, Math.min(97, Math.round(56 + 700 * margin)));
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

function tableHtml(columns, rows) {
  const head = `<tr>${columns.map((c) => `<th>${c.label}</th>`).join("")}</tr>`;
  const body = rows
    .map((row) => {
      const cells = columns.map((c) => `<td>${c.render(row)}</td>`).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<thead>${head}</thead><tbody>${body}</tbody>`;
}

function setStep(step) {
  state.currentStep = step;
  for (const id of [1, 2, 3]) {
    els.screens[id].classList.toggle("is-hidden", id !== step);
    els.stepBtns[id].classList.toggle("is-active", id === step);
  }
}

function setPlayState(text, tone = "neutral") {
  els.playState.className = `status${tone === "good" ? " good" : tone === "warn" ? " warn" : ""}`;
  els.playState.textContent = text;
}

function updateSliderLabels() {
  els.clarityValue.textContent = String(els.clarity.value);
  els.noiseValue.textContent = String(els.noise.value);
  els.comfortValue.textContent = String(els.comfort.value);
}

function renderSceneCards() {
  els.sceneCards.innerHTML = "";
  for (const scene of state.bundle.scenes) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `scene-card${scene.id === state.selectedSceneId ? " is-active" : ""}`;
    btn.innerHTML = `<span class="name">${scene.label}</span><span class="desc">${scene.description}</span>`;
    btn.addEventListener("click", () => {
      if (state.selectedSceneId === scene.id) {
        return;
      }
      state.selectedSceneId = scene.id;
      renderSceneCards();
      runRecommendation(false);
      renderSavedState();
    });
    els.sceneCards.appendChild(btn);
  }
}

function renderGoalChips() {
  els.goalChips.innerHTML = "";
  for (const label of Object.keys(state.bundle.goal_presets)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `goal-chip${label === state.selectedGoal ? " is-active" : ""}`;
    btn.textContent = label;
    btn.addEventListener("click", () => {
      state.selectedGoal = label;
      applyGoalPreset(label);
      renderGoalChips();
      runRecommendation(false);
    });
    els.goalChips.appendChild(btn);
  }
}

function applyGoalPreset(goalLabel) {
  const preset = state.bundle.goal_presets[goalLabel] || state.bundle.goal_presets[DEFAULT_GOAL];
  els.clarity.value = String(preset.clarity);
  els.noise.value = String(preset.noise);
  els.comfort.value = String(preset.comfort);
  updateSliderLabels();
  els.goalCoach.innerHTML = `
    <h3>Current goal</h3>
    <p><b>${goalLabel}</b></p>
    <p>${preset.coach_text}</p>
  `;
}

function stopAudio() {
  if (state.abTimer) {
    clearInterval(state.abTimer);
    state.abTimer = null;
  }
  els.beforeAudio.pause();
  els.afterAudio.pause();
  setPlayState("Idle", "neutral");
}

function currentSyncTime() {
  if (!els.beforeAudio.paused) {
    return els.beforeAudio.currentTime;
  }
  if (!els.afterAudio.paused) {
    return els.afterAudio.currentTime;
  }
  return Math.max(els.beforeAudio.currentTime || 0, els.afterAudio.currentTime || 0);
}

async function playSingle(which) {
  stopAudio();
  const src = which === "before" ? els.beforeAudio : els.afterAudio;
  const other = which === "before" ? els.afterAudio : els.beforeAudio;
  other.pause();

  try {
    src.currentTime = Math.min(currentSyncTime(), Math.max(0, (src.duration || 0.1) - 0.05));
  } catch {
    src.currentTime = 0;
  }

  try {
    await src.play();
  } catch {
    return;
  }

  if (which === "before") {
    setPlayState("Playing raw", "warn");
  } else {
    setPlayState("Playing AI enhanced", "good");
  }
}

function abStep() {
  const playBefore = state.abNext === "before";
  const src = playBefore ? els.beforeAudio : els.afterAudio;
  const other = playBefore ? els.afterAudio : els.beforeAudio;

  other.pause();
  try {
    src.currentTime = Math.min(currentSyncTime(), Math.max(0, (src.duration || 0.1) - 0.05));
  } catch {
    src.currentTime = 0;
  }

  src.play().catch(() => {
    stopAudio();
  });

  setPlayState(playBefore ? "A/B raw" : "A/B AI enhanced", playBefore ? "warn" : "good");
  state.abNext = playBefore ? "after" : "before";
}

function startAB() {
  stopAudio();
  state.abNext = "before";
  abStep();
  state.abTimer = setInterval(abStep, AB_TOGGLE_MS);
}

function renderImpactCard(el, label, value, hint, tone = "good") {
  el.className = `impact ${tone}`;
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

function runRecommendation(scrollToStep2) {
  const scene = state.sceneMap[state.selectedSceneId];

  const weightsCfg = personalizedWeightsConfig(els.clarity.value, els.noise.value, els.comfort.value);
  const { scored, weights } = scoreScene(scene.id, weightsCfg);
  const winner = scored[0];
  const runner = scored[1];
  const margin = winner.score - runner.score;
  const conf = decisionConfidence(margin);

  state.lastWeightsCfg = weightsCfg;
  state.lastWinner = winner;

  stopAudio();
  els.beforeAudio.src = scene.audio.noisy;
  els.afterAudio.src = winner.audio_path;

  const top = topContributions(winner.contributions, 2)
    .map(([f]) => FEATURE_LABELS[f])
    .join(" + ");

  const focus = Object.entries(weights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([f, w]) => `${FEATURE_LABELS[f]} (${fmt(w, 2)})`)
    .join(", ");

  els.compareCaption.textContent = `Scene: ${scene.label}. Smart A/B compares the same moment before vs AI enhancement.`;
  els.winnerHero.innerHTML = `
    <h3>AI selected ${winner.profile_name}</h3>
    <p>${winner.profile_description}</p>
  `;

  const metrics = state.bundle.audio_metrics?.[scene.id]?.[winner.profile_id] || {
    noise_floor_drop_db: 0,
    speech_band_shift_db: 0,
    speech_focus_delta_pct: 0,
  };

  const floor = Number(metrics.noise_floor_drop_db);
  const speech = Number(metrics.speech_band_shift_db);
  const focusShift = Number(metrics.speech_focus_delta_pct);

  renderImpactCard(
    els.impactA,
    floor >= 0 ? "Background reduction" : "Ambience retained",
    `${fmtSigned(floor, 1)} dB`,
    floor >= 0 ? "Lower background floor after AI." : "Natural ambience kept.",
    floor >= 0 ? "good" : "warn",
  );

  renderImpactCard(
    els.impactB,
    "Speech presence",
    `${fmtSigned(speech, 1)} dB`,
    "Change in speech-focused band energy.",
    speech >= 0 ? "good" : "warn",
  );

  renderImpactCard(
    els.impactC,
    "Decision confidence",
    `${conf.pct}%`,
    `Score margin ${fmt(margin)} · focus shift ${fmtSigned(focusShift, 1)} pts.`,
    conf.level === "High" || conf.level === "Moderate" ? "good" : "warn",
  );

  els.winnerCard.innerHTML = `
    <h3>Primary setting</h3>
    <p><b>${winner.profile_name}</b></p>
    <p>For <b>${scene.label}</b></p>
    <p>Goal matched: <b>${state.selectedGoal}</b></p>
  `;

  els.confidenceCard.innerHTML = `
    <h3>Why this wins</h3>
    <p>Top evidence: <b>${top}</b></p>
    <p>Scene weighting priority: ${focus}</p>
    <p>Backup profile: <b>${runner.profile_name}</b></p>
  `;

  els.actionCard.innerHTML = `
    <h3>How to use it</h3>
    <p>1. Use <b>${winner.profile_name}</b> in this scene.</p>
    <p>2. If it feels too strong, switch to <b>${runner.profile_name}</b>.</p>
    <p>3. Save this for faster switching next time.</p>
  `;

  renderScoreTable(scored);

  if (scrollToStep2) {
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

function renderSavedState() {
  const saved = getSavedMap()[state.selectedSceneId];
  if (!saved) {
    els.savedNote.classList.add("is-hidden");
    return;
  }
  els.savedNote.classList.remove("is-hidden");
  els.savedNote.innerHTML = `<b>Saved:</b> ${saved.profile_name} for ${saved.scene_label}`;
}

function applyLocalPreferenceUpdate(weightsCfg, targetScene, preferredProfile) {
  const updatedCfg = clone(weightsCfg);
  const rule = state.bundle.weights.update_rule;

  const sceneRows = state.featuresByScene[targetScene];
  const scoresBefore = scoreAllScenes(weightsCfg);
  const sceneBefore = [...scoresBefore[targetScene]];
  const currentWinner = sceneBefore[0].profile_id;

  const winnerFeatures = sceneRows.find((r) => r.profile_id === currentWinner);
  const preferredFeatures = sceneRows.find((r) => r.profile_id === preferredProfile);

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
  FEATURE_COLUMNS.forEach((f, i) => {
    newWeightObj[f] = Math.max(1e-6, updated[i]);
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
    for (const b of beforeRows) {
      const a = afterRows.find((row) => row.profile_id === b.profile_id);
      localMax = Math.max(localMax, Math.abs(a.score - b.score));
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
  const weightsCfg = state.lastWeightsCfg || personalizedWeightsConfig(els.clarity.value, els.noise.value, els.comfort.value);
  const targetScene = els.feedbackSceneSelect.value;
  const preferredProfile = els.feedbackProfileSelect.value;

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
    <h3>Update result</h3>
    <p>Target scene: <b>${state.sceneMap[targetScene].label}</b></p>
    <p>Preferred profile: <b>${state.profileMap[preferredProfile].name}</b></p>
    <p>Winner: <b>${beforeWinner}</b> → <b>${afterWinner}</b> (${changed ? "changed" : "unchanged"})</p>
    <p>Non-target drift: <b>${fmt(update.diagnostics.max_non_target_abs_score_shift, 5)}</b> / threshold ${fmt(update.diagnostics.threshold, 5)} (${stable ? "PASS" : "FAIL"})</p>
  `;
}

function initControls() {
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
  if (!state.bundle.goal_presets[state.selectedGoal]) {
    state.selectedGoal = Object.keys(state.bundle.goal_presets)[0];
  }

  els.feedbackSceneSelect.value = sceneIds.has(DEFAULT_FEEDBACK_SCENE) ? DEFAULT_FEEDBACK_SCENE : state.selectedSceneId;
  els.feedbackProfileSelect.value = DEFAULT_FEEDBACK_PROFILE;

  applyGoalPreset(state.selectedGoal);
  renderSceneCards();
  renderGoalChips();
  renderSavedState();
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

async function init() {
  try {
    await loadBundle();
    initControls();
    setStep(1);

    for (const slider of [els.clarity, els.noise, els.comfort]) {
      slider.addEventListener("input", () => {
        updateSliderLabels();
        runRecommendation(false);
      });
    }

    els.heroStartBtn.addEventListener("click", () => {
      runRecommendation(true);
      startAB();
      renderFeedback();
    });

    els.toStep2Btn.addEventListener("click", () => {
      runRecommendation(true);
      renderFeedback();
    });

    els.toStep3Btn.addEventListener("click", () => {
      setStep(3);
      renderSavedState();
    });

    els.backTo1Btn.addEventListener("click", () => setStep(1));
    els.backTo2Btn.addEventListener("click", () => setStep(2));

    els.stepBtns[1].addEventListener("click", () => setStep(1));
    els.stepBtns[2].addEventListener("click", () => setStep(2));
    els.stepBtns[3].addEventListener("click", () => setStep(3));

    els.playBeforeBtn.addEventListener("click", () => playSingle("before"));
    els.playAfterBtn.addEventListener("click", () => playSingle("after"));
    els.playABBtn.addEventListener("click", () => startAB());
    els.stopBtn.addEventListener("click", () => stopAudio());

    els.saveSettingBtn.addEventListener("click", () => saveCurrentSceneSetting());

    els.applyFeedbackBtn.addEventListener("click", () => renderFeedback());

    runRecommendation(false);
    renderFeedback();
  } catch (error) {
    document.body.innerHTML = `<main class="shell"><section class="hero"><h2>Failed to load demo</h2><p>${String(error)}</p></section></main>`;
  }
}

init();
