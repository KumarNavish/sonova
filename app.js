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

const DEFAULT_GOAL = "Hear speech clearly in noise";
const DEFAULT_SCENE = "crowd_social";
const AB_TOGGLE_MS = 1150;

const els = {
  heroSceneLabel: document.getElementById("hero-scene-label"),
  demoCompareBtn: document.getElementById("demo-compare-btn"),

  scenePills: document.getElementById("scene-pills"),
  sceneOverview: document.getElementById("scene-overview"),

  goalSelect: document.getElementById("goal-select"),
  applyGoalBtn: document.getElementById("apply-goal-btn"),
  goalCoach: document.getElementById("goal-coach"),

  clarity: document.getElementById("clarity-slider"),
  noise: document.getElementById("noise-slider"),
  comfort: document.getElementById("comfort-slider"),
  clarityValue: document.getElementById("clarity-value"),
  noiseValue: document.getElementById("noise-value"),
  comfortValue: document.getElementById("comfort-value"),

  runBtn: document.getElementById("run-btn"),

  compareCaption: document.getElementById("compare-caption"),
  beforeAudio: document.getElementById("before-audio"),
  afterAudio: document.getElementById("after-audio"),
  noiseAudio: document.getElementById("noise-audio"),
  playBeforeBtn: document.getElementById("play-before-btn"),
  playAfterBtn: document.getElementById("play-after-btn"),
  playABBtn: document.getElementById("play-ab-btn"),
  stopBtn: document.getElementById("stop-btn"),
  nowPlayingBadge: document.getElementById("now-playing-badge"),
  abHint: document.getElementById("ab-hint"),

  impactNoise: document.getElementById("impact-noise"),
  impactSpeech: document.getElementById("impact-speech"),
  impactHarshness: document.getElementById("impact-harshness"),
  impactFocus: document.getElementById("impact-focus"),

  winnerCard: document.getElementById("winner-card"),
  confidenceCard: document.getElementById("confidence-card"),
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
  lastWeightsCfg: null,
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
  const pct = Math.max(55, Math.min(97, Math.round(56 + 720 * margin)));
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

function updateSliderLabels() {
  els.clarityValue.textContent = String(els.clarity.value);
  els.noiseValue.textContent = String(els.noise.value);
  els.comfortValue.textContent = String(els.comfort.value);
}

function renderScenePills() {
  els.scenePills.innerHTML = "";
  for (const scene of state.bundle.scenes) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `pill${scene.id === state.selectedSceneId ? " is-active" : ""}`;
    btn.textContent = scene.label;
    btn.addEventListener("click", () => {
      if (state.selectedSceneId === scene.id) {
        return;
      }
      state.selectedSceneId = scene.id;
      renderScenePills();
      renderSceneInfo();
      runConcierge();
    });
    els.scenePills.appendChild(btn);
  }
}

function renderSceneInfo() {
  const scene = state.sceneMap[state.selectedSceneId];
  els.sceneOverview.innerHTML = `
    <h3>${scene.label}</h3>
    <p>${scene.description}</p>
    <p class="muted">Input clip length: ${fmt(state.bundle.clip_duration_sec, 1)}s · Public voice/noise sources only.</p>
  `;
  els.heroSceneLabel.textContent = `Scene: ${scene.label}`;
}

function renderGoalCoach(goalLabel) {
  const preset = state.bundle.goal_presets[goalLabel];
  els.goalCoach.innerHTML = `
    <h3>Current intent</h3>
    <p><b>${goalLabel}</b></p>
    <p>${preset.coach_text}</p>
  `;
}

function applyGoalPreset() {
  const goal = els.goalSelect.value;
  const preset = state.bundle.goal_presets[goal] || state.bundle.goal_presets[DEFAULT_GOAL];
  els.clarity.value = String(preset.clarity);
  els.noise.value = String(preset.noise);
  els.comfort.value = String(preset.comfort);
  updateSliderLabels();
  renderGoalCoach(goal);
}

function setBadge(text, tone = "neutral") {
  const toneClass = tone === "good" ? " good" : tone === "warn" ? " warn" : "";
  els.nowPlayingBadge.className = `badge${toneClass}`;
  els.nowPlayingBadge.textContent = text;
}

function stopAudio() {
  if (state.abTimer) {
    clearInterval(state.abTimer);
    state.abTimer = null;
  }
  for (const el of [els.beforeAudio, els.afterAudio, els.noiseAudio]) {
    el.pause();
  }
  setBadge("Idle", "neutral");
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
  const t = currentSyncTime();
  const src = which === "before" ? els.beforeAudio : which === "after" ? els.afterAudio : els.noiseAudio;
  if (which !== "noise") {
    const other = which === "before" ? els.afterAudio : els.beforeAudio;
    other.pause();
    try {
      src.currentTime = Math.min(t, Math.max(0, (src.duration || t + 0.1) - 0.05));
    } catch {
      src.currentTime = 0;
    }
  }
  try {
    await src.play();
  } catch {
    return;
  }
  if (which === "before") {
    setBadge("Playing: raw input", "warn");
  } else if (which === "after") {
    setBadge("Playing: AI enhanced", "good");
  } else {
    setBadge("Playing: scene background bed", "neutral");
  }
}

function toggleABStep() {
  const playBefore = state.abNext === "before";
  const src = playBefore ? els.beforeAudio : els.afterAudio;
  const other = playBefore ? els.afterAudio : els.beforeAudio;

  const t = currentSyncTime();
  other.pause();
  try {
    src.currentTime = Math.min(t, Math.max(0, (src.duration || t + 0.1) - 0.05));
  } catch {
    src.currentTime = 0;
  }

  src.play().catch(() => {
    stopAudio();
  });

  setBadge(playBefore ? "A/B: raw" : "A/B: AI enhanced", playBefore ? "warn" : "good");
  state.abNext = playBefore ? "after" : "before";
}

function startABTurbo() {
  stopAudio();
  state.abNext = "before";
  toggleABStep();
  state.abTimer = setInterval(toggleABStep, AB_TOGGLE_MS);
}

function renderImpactCard(el, title, valueText, hint, tone = "good") {
  el.className = `impact-card ${tone}`;
  el.innerHTML = `
    <h3>${title}</h3>
    <p class="value">${valueText}</p>
    <p class="hint">${hint}</p>
  `;
}

function renderImpactMetrics(sceneId, winnerProfileId) {
  const byScene = state.bundle.audio_metrics?.[sceneId] || {};
  const metrics = byScene[winnerProfileId] || {
    noise_floor_drop_db: 0,
    speech_band_shift_db: 0,
    harshness_reduction_db: 0,
    speech_focus_delta_pct: 0,
  };

  renderImpactCard(
    els.impactNoise,
    "Background floor",
    `${fmtSigned(metrics.noise_floor_drop_db, 1)} dB`,
    "Positive means quieter low-level background after AI.",
    metrics.noise_floor_drop_db >= 0 ? "good" : "warn",
  );

  renderImpactCard(
    els.impactSpeech,
    "Speech band",
    `${fmtSigned(metrics.speech_band_shift_db, 1)} dB`,
    "Energy shift in the critical 1-3.6 kHz speech region.",
    metrics.speech_band_shift_db >= 0 ? "good" : "warn",
  );

  renderImpactCard(
    els.impactHarshness,
    "Harshness",
    `${fmtSigned(metrics.harshness_reduction_db, 1)} dB`,
    "Positive means less high-frequency sharpness.",
    metrics.harshness_reduction_db >= 0 ? "good" : "warn",
  );

  renderImpactCard(
    els.impactFocus,
    "Speech focus",
    `${fmtSigned(metrics.speech_focus_delta_pct, 1)} pts`,
    "Share of speech-like energy compared with full-band energy.",
    metrics.speech_focus_delta_pct >= 0 ? "good" : "warn",
  );
}

function renderScoreTable(scored) {
  const columns = [
    { label: "Rank", render: (r) => r.rank },
    { label: "Profile", render: (r) => r.profile_name },
    { label: "Utility", render: (r) => fmt(r.score) },
    ...FEATURE_COLUMNS.map((f) => ({
      label: FEATURE_LABELS[f],
      render: (r) => fmt(r[f]),
    })),
  ];
  els.scoreTable.innerHTML = tableHtml(columns, scored);
}

function runConcierge() {
  const scene = state.sceneMap[state.selectedSceneId];
  const goalLabel = els.goalSelect.value;
  const clarity = Number(els.clarity.value);
  const noise = Number(els.noise.value);
  const comfort = Number(els.comfort.value);

  const weightsCfg = personalizedWeightsConfig(clarity, noise, comfort);
  const { scored, weights } = scoreScene(scene.id, weightsCfg);
  const winner = scored[0];
  const runner = scored[1];
  const margin = winner.score - runner.score;
  const conf = decisionConfidence(margin);

  const top = topContributions(winner.contributions, 2)
    .map(([f]) => FEATURE_LABELS[f])
    .join(" + ");

  const weightFocus = Object.entries(weights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([f, w]) => `${FEATURE_LABELS[f]} (${fmt(w, 2)})`)
    .join(", ");

  stopAudio();
  els.beforeAudio.src = scene.audio.noisy;
  els.afterAudio.src = winner.audio_path;
  els.noiseAudio.src = scene.audio.noise_bed;

  els.compareCaption.textContent = `In ${scene.label}, AI selected ${winner.profile_name}. Use A/B turbo to hear the same moment switching between raw and enhanced audio.`;

  els.winnerCard.innerHTML = `
    <h3>AI Pick: ${winner.profile_name}</h3>
    <p>${winner.profile_description}</p>
    <p><b>Scene:</b> ${scene.label}</p>
    <p><b>Top evidence:</b> ${top}</p>
    <p><b>Scene weight focus:</b> ${weightFocus}</p>
  `;

  els.confidenceCard.innerHTML = `
    <h3>Decision confidence</h3>
    <p><b>${conf.level}</b> (${conf.pct}%)</p>
    <p>Margin vs next best (${runner.profile_name}): <b>${fmt(margin)}</b></p>
    <p><b>User goal:</b> ${goalLabel}</p>
  `;

  renderImpactMetrics(scene.id, winner.profile_id);
  renderScoreTable(scored);

  state.lastWeightsCfg = weightsCfg;
  return { weightsCfg, scoredByScene: scoreAllScenes(weightsCfg), winner };
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
  let preserved = 0;
  let nonTargetCount = 0;
  const stabilityRows = [];

  for (const scene of state.bundle.scenes) {
    if (scene.id === targetScene) {
      continue;
    }
    nonTargetCount += 1;
    const beforeRows = scoresBefore[scene.id];
    const afterRows = scoresAfter[scene.id];

    const beforeWinner = beforeRows[0].profile_id;
    const afterWinner = afterRows[0].profile_id;
    if (beforeWinner === afterWinner) {
      preserved += 1;
    }

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
    updatedCfg,
    diagnostics: {
      winner_before: sceneBefore[0].profile_id,
      winner_after: sceneAfter[0].profile_id,
      max_non_target_abs_score_shift: maxNonTargetShift,
      threshold: Number(rule.non_target_max_abs_score_shift_threshold),
      non_target_winner_preservation_fraction: nonTargetCount > 0 ? preserved / nonTargetCount : 1,
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
  const before = update.sceneBefore;
  const after = update.sceneAfter;

  const columns = [
    { label: "Profile", render: (r) => state.profileMap[r.profile_id].name },
    { label: "Score", render: (r) => fmt(r.score) },
    { label: "Rank", render: (r) => r.rank },
  ];
  els.feedbackBeforeTable.innerHTML = tableHtml(columns, before);
  els.feedbackAfterTable.innerHTML = tableHtml(columns, after);

  const stabilityColumns = [
    { label: "Scene", render: (r) => r.scene },
    { label: "Winner before", render: (r) => r.winner_before },
    { label: "Winner after", render: (r) => r.winner_after },
    { label: "Status", render: (r) => r.status },
    { label: "Max abs shift", render: (r) => fmt(r.abs_shift, 5) },
  ];
  els.stabilityTable.innerHTML = tableHtml(stabilityColumns, update.stabilityRows);

  const winnerBeforeName = state.profileMap[update.diagnostics.winner_before].name;
  const winnerAfterName = state.profileMap[update.diagnostics.winner_after].name;
  const changed = winnerBeforeName !== winnerAfterName;
  const stable = update.diagnostics.max_non_target_abs_score_shift <= update.diagnostics.threshold;

  els.feedbackSummary.innerHTML = `
    <h3>Update result</h3>
    <p>Target scene: <b>${state.sceneMap[targetScene].label}</b></p>
    <p>Preferred profile: <b>${state.profileMap[preferredProfile].name}</b></p>
    <p>Target winner: <b>${winnerBeforeName}</b> → <b>${winnerAfterName}</b> (${changed ? "changed" : "unchanged"})</p>
    <p>Non-target drift: <b>${fmt(update.diagnostics.max_non_target_abs_score_shift, 5)}</b> (threshold ${fmt(update.diagnostics.threshold, 5)}) ${stable ? "PASS" : "FAIL"}</p>
    <p>Non-target winner preservation: <b>${fmt(update.diagnostics.non_target_winner_preservation_fraction, 3)}</b></p>
  `;
}

function initControls() {
  for (const goalLabel of Object.keys(state.bundle.goal_presets)) {
    const option = document.createElement("option");
    option.value = goalLabel;
    option.textContent = goalLabel;
    els.goalSelect.appendChild(option);
  }

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
  const defaultFeedbackScene = sceneIds.has("meeting_room") ? "meeting_room" : state.selectedSceneId;
  els.feedbackSceneSelect.value = defaultFeedbackScene;
  els.goalSelect.value = Object.prototype.hasOwnProperty.call(state.bundle.goal_presets, DEFAULT_GOAL)
    ? DEFAULT_GOAL
    : Object.keys(state.bundle.goal_presets)[0];
  els.feedbackProfileSelect.value = "comfort_softness";

  renderScenePills();
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
    applyGoalPreset();
    renderSceneInfo();

    for (const slider of [els.clarity, els.noise, els.comfort]) {
      slider.addEventListener("input", updateSliderLabels);
    }

    els.applyGoalBtn.addEventListener("click", () => {
      applyGoalPreset();
      runConcierge();
      renderFeedback();
    });

    els.runBtn.addEventListener("click", () => {
      runConcierge();
      renderFeedback();
    });

    els.playBeforeBtn.addEventListener("click", () => {
      playSingle("before");
    });

    els.playAfterBtn.addEventListener("click", () => {
      playSingle("after");
    });

    els.playABBtn.addEventListener("click", () => {
      startABTurbo();
    });

    els.stopBtn.addEventListener("click", () => {
      stopAudio();
    });

    els.demoCompareBtn.addEventListener("click", () => {
      runConcierge();
      startABTurbo();
      document.getElementById("compare-step")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    els.applyFeedbackBtn.addEventListener("click", () => {
      renderFeedback();
    });

    const initial = runConcierge();
    renderFeedback(initial.weightsCfg);
  } catch (error) {
    document.body.innerHTML = `<main class="shell"><section class="card"><h2>Failed to load demo</h2><p>${String(error)}</p></section></main>`;
  }
}

init();
