const FEATURE_COLUMNS = [
  "intelligibility",
  "noise_control",
  "comfort",
  "loudness_stability",
  "speech_prominence",
];

const FEATURE_LABELS = {
  intelligibility: "Word clarity",
  noise_control: "Background reduction",
  comfort: "Listening comfort",
  loudness_stability: "Volume steadiness",
  speech_prominence: "Speech-in-front focus",
};

const DEFAULT_GOAL = "Balanced everyday listening";

const els = {
  sceneSelect: document.getElementById("scene-select"),
  goalSelect: document.getElementById("goal-select"),
  applyGoalBtn: document.getElementById("apply-goal-btn"),
  runBtn: document.getElementById("run-btn"),
  goalCoach: document.getElementById("goal-coach"),
  sceneOverview: document.getElementById("scene-overview"),
  clarity: document.getElementById("clarity-slider"),
  noise: document.getElementById("noise-slider"),
  comfort: document.getElementById("comfort-slider"),
  clarityValue: document.getElementById("clarity-value"),
  noiseValue: document.getElementById("noise-value"),
  comfortValue: document.getElementById("comfort-value"),
  beforeAudio: document.getElementById("before-audio"),
  afterAudio: document.getElementById("after-audio"),
  winnerCard: document.getElementById("winner-card"),
  confidenceCard: document.getElementById("confidence-card"),
  impactCard: document.getElementById("impact-card"),
  actionCard: document.getElementById("action-card"),
  scoreTable: document.getElementById("score-table"),
  buildPlanBtn: document.getElementById("build-plan-btn"),
  planSummary: document.getElementById("plan-summary"),
  planTable: document.getElementById("plan-table"),
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
  featuresByScene: {},
  sceneMap: {},
  profileMap: {},
};

function fmt(value, decimals = 3) {
  return Number(value).toFixed(decimals);
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
    const contrib = Number(weights[feature]) * value;
    contributions[feature] = contrib;
    score += contrib;
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
  scored.forEach((row, index) => {
    row.rank = index + 1;
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
  const pct = Math.max(55, Math.min(96, Math.round(56 + 700 * margin)));
  if (margin >= 0.045) {
    return { level: "High", pct };
  }
  if (margin >= 0.02) {
    return { level: "Moderate", pct };
  }
  return { level: "Watch-and-listen", pct };
}

function topContributions(contributions, topK = 2) {
  return Object.entries(contributions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK);
}

function sceneTip(sceneId) {
  const tips = {
    quiet_conversation: "Best for calm one-to-one speech; focus on naturalness and comfort.",
    cafe_restaurant: "Best for hearing your table partner over competing voices.",
    traffic_street: "Best for outdoor speech with noise under control.",
    meeting_room: "Best for meetings where typing and side noise mask words.",
    tv_media_listening: "Best for TV dialog clarity at comfortable loudness.",
    crowd_social: "Best for focusing on the speaker in front of you.",
  };
  return tips[sceneId] || "Pick the nearest real-world context.";
}

function renderSceneOverview(scene) {
  els.sceneOverview.innerHTML = `
    <h3>${scene.label}</h3>
    <p>${scene.description}</p>
    <p><b>Real-life tip:</b> ${sceneTip(scene.id)}</p>
  `;
}

function renderGoalCoach(goalLabel) {
  const preset = state.bundle.goal_presets[goalLabel];
  els.goalCoach.innerHTML = `
    <h3>AI Goal Coach</h3>
    <p><b>${goalLabel}</b></p>
    <p>${preset.coach_text}</p>
  `;
}

function updateSliderLabels() {
  els.clarityValue.textContent = String(els.clarity.value);
  els.noiseValue.textContent = String(els.noise.value);
  els.comfortValue.textContent = String(els.comfort.value);
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

function renderScoreTable(scored) {
  const columns = [
    { label: "Rank", render: (r) => r.rank },
    { label: "Profile", render: (r) => r.profile_name },
    { label: "Score", render: (r) => fmt(r.score) },
    ...FEATURE_COLUMNS.map((feature) => ({
      label: FEATURE_LABELS[feature],
      render: (r) => fmt(r[feature]),
    })),
  ];
  els.scoreTable.innerHTML = tableHtml(columns, scored);
}

function runConcierge() {
  const sceneId = els.sceneSelect.value;
  const goalLabel = els.goalSelect.value;
  const clarity = Number(els.clarity.value);
  const noise = Number(els.noise.value);
  const comfort = Number(els.comfort.value);

  const weightsCfg = personalizedWeightsConfig(clarity, noise, comfort);
  const { scored, weights } = scoreScene(sceneId, weightsCfg);
  const scene = state.sceneMap[sceneId];
  const winner = scored[0];
  const runner = scored[1];
  const margin = winner.score - runner.score;
  const conf = decisionConfidence(margin);
  const top = topContributions(winner.contributions, 2)
    .map(([feature, value]) => `${FEATURE_LABELS[feature]} (${fmt(value)})`)
    .join(", ");

  const weightFocus = Object.entries(weights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([feature, value]) => `${FEATURE_LABELS[feature]} (${fmt(value, 2)})`)
    .join(", ");

  const baseline = scored.find((r) => r.profile_id === "balanced_default") || runner;
  const deltas = FEATURE_COLUMNS.map((feature) => ({
    feature,
    delta: winner[feature] - baseline[feature],
  })).sort((a, b) => b.delta - a.delta);

  const topDelta = deltas.slice(0, 2)
    .map((d) => `<li>${FEATURE_LABELS[d.feature]}: ${d.delta >= 0 ? "+" : ""}${fmt(d.delta)}</li>`)
    .join("");
  const worstDelta = deltas[deltas.length - 1];

  els.beforeAudio.src = scene.audio.noisy;
  els.afterAudio.src = winner.audio_path;

  els.winnerCard.innerHTML = `
    <h3>AI Concierge Pick: ${winner.profile_name}</h3>
    <p><b>Scene:</b> ${scene.label}</p>
    <p><b>Goal:</b> ${goalLabel}</p>
    <p><b>Why it won:</b> ${top}</p>
    <p><b>AI focus:</b> ${weightFocus}</p>
    <p><b>Backup mode:</b> ${runner.profile_name}</p>
  `;

  els.confidenceCard.innerHTML = `
    <h3>Decision confidence</h3>
    <p><span class="tag">${conf.level} (${conf.pct}%)</span></p>
    <div class="confidence-track"><div class="confidence-fill" style="width:${conf.pct}%;"></div></div>
    <p>Margin vs backup: ${fmt(margin)} utility points</p>
  `;

  els.impactCard.innerHTML = `
    <h3>Expected immediate impact</h3>
    <ul>${topDelta}</ul>
    <p class="${worstDelta.delta < 0 ? "warning" : ""}">Trade-off check: ${FEATURE_LABELS[worstDelta.feature]} ${worstDelta.delta >= 0 ? "stable" : "slightly lower"} (${worstDelta.delta >= 0 ? "+" : ""}${fmt(worstDelta.delta)} vs balanced).</p>
  `;

  els.actionCard.innerHTML = `
    <h3>What to do next</h3>
    <p>1) Play before/after once.</p>
    <p>2) Use <b>${winner.profile_name}</b> for your next real conversation.</p>
    <p>3) If it feels too processed, switch to <b>${runner.profile_name}</b>.</p>
  `;

  renderScoreTable(scored);
  return { weightsCfg, scoredByScene: scoreAllScenes(weightsCfg) };
}

function buildDayPlan(scoredByScene) {
  const rows = [];
  for (const scene of state.bundle.scenes) {
    const scored = scoredByScene[scene.id];
    const winner = scored[0];
    const runner = scored[1];
    rows.push({
      moment: state.bundle.scene_moments[scene.id] || scene.label,
      environment: scene.label,
      ai_pick: winner.profile_name,
      backup: runner.profile_name,
      margin: winner.score - runner.score,
    });
  }

  const diversity = new Set(rows.map((r) => r.ai_pick)).size;
  const strongest = [...rows].sort((a, b) => b.margin - a.margin)[0];
  els.planSummary.innerHTML = `
    <h3>Your smart day plan</h3>
    <p>Prepared ${rows.length} moment-level recommendations with ${diversity} unique profile choices.</p>
    <p>Most confident moment: <b>${strongest.moment}</b> with <b>${strongest.ai_pick}</b>.</p>
  `;

  const columns = [
    { label: "Daily moment", render: (r) => r.moment },
    { label: "Environment", render: (r) => r.environment },
    { label: "AI pick", render: (r) => r.ai_pick },
    { label: "Backup", render: (r) => r.backup },
    { label: "Decision margin", render: (r) => fmt(r.margin) },
  ];
  els.planTable.innerHTML = tableHtml(columns, rows);
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
    for (const beforeRow of beforeRows) {
      const afterRow = afterRows.find((row) => row.profile_id === beforeRow.profile_id);
      localMax = Math.max(localMax, Math.abs(afterRow.score - beforeRow.score));
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

function renderFeedback(scoredByScene, weightsCfg) {
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
    { label: "Max abs score shift", render: (r) => fmt(r.abs_shift, 5) },
  ];
  els.stabilityTable.innerHTML = tableHtml(stabilityColumns, update.stabilityRows);

  const winnerBeforeName = state.profileMap[update.diagnostics.winner_before].name;
  const winnerAfterName = state.profileMap[update.diagnostics.winner_after].name;
  const changed = winnerBeforeName !== winnerAfterName;
  const stable = update.diagnostics.max_non_target_abs_score_shift <= update.diagnostics.threshold;

  els.feedbackSummary.innerHTML = `
    <h3>Feedback applied safely</h3>
    <p>Target scene: <b>${state.sceneMap[targetScene].label}</b></p>
    <p>Preferred profile: <b>${state.profileMap[preferredProfile].name}</b></p>
    <p>Target winner ${changed ? "changed as requested" : "did not change yet"}: <b>${winnerBeforeName}</b> -> <b>${winnerAfterName}</b></p>
    <p>Non-target stability: <b>${fmt(update.diagnostics.max_non_target_abs_score_shift, 5)}</b> max shift vs threshold <b>${fmt(update.diagnostics.threshold, 5)}</b> (${stable ? "PASS" : "FAIL"}).</p>
    <p>Non-target winner preservation fraction: <b>${fmt(update.diagnostics.non_target_winner_preservation_fraction, 3)}</b></p>
  `;
}

function initControls() {
  for (const scene of state.bundle.scenes) {
    const opt1 = document.createElement("option");
    opt1.value = scene.id;
    opt1.textContent = scene.label;
    els.sceneSelect.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = scene.id;
    opt2.textContent = scene.label;
    els.feedbackSceneSelect.appendChild(opt2);
  }

  for (const goalLabel of Object.keys(state.bundle.goal_presets)) {
    const option = document.createElement("option");
    option.value = goalLabel;
    option.textContent = goalLabel;
    els.goalSelect.appendChild(option);
  }

  for (const profile of state.bundle.profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    els.feedbackProfileSelect.appendChild(option);
  }

  els.sceneSelect.value = state.bundle.scenes.find((s) => s.id === "tv_media_listening") ? "tv_media_listening" : state.bundle.scenes[0].id;
  els.feedbackSceneSelect.value = els.sceneSelect.value;
  els.goalSelect.value = DEFAULT_GOAL;
  els.feedbackProfileSelect.value = "noise_suppression_emphasis";
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
    renderSceneOverview(state.sceneMap[els.sceneSelect.value]);

    for (const slider of [els.clarity, els.noise, els.comfort]) {
      slider.addEventListener("input", updateSliderLabels);
    }

    els.sceneSelect.addEventListener("change", () => {
      renderSceneOverview(state.sceneMap[els.sceneSelect.value]);
      els.feedbackSceneSelect.value = els.sceneSelect.value;
    });

    els.applyGoalBtn.addEventListener("click", () => {
      applyGoalPreset();
      runConcierge();
    });

    els.runBtn.addEventListener("click", () => {
      runConcierge();
    });

    els.buildPlanBtn.addEventListener("click", () => {
      const weightsCfg = personalizedWeightsConfig(els.clarity.value, els.noise.value, els.comfort.value);
      const scoredByScene = scoreAllScenes(weightsCfg);
      buildDayPlan(scoredByScene);
    });

    els.applyFeedbackBtn.addEventListener("click", () => {
      const weightsCfg = personalizedWeightsConfig(els.clarity.value, els.noise.value, els.comfort.value);
      const scoredByScene = scoreAllScenes(weightsCfg);
      renderFeedback(scoredByScene, weightsCfg);
    });

    const initial = runConcierge();
    buildDayPlan(initial.scoredByScene);
    renderFeedback(initial.scoredByScene, initial.weightsCfg);
  } catch (error) {
    document.body.innerHTML = `<main class="page"><section class="panel"><h2>Failed to load demo</h2><p>${String(error)}</p></section></main>`;
  }
}

init();
