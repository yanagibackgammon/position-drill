"use strict";

const POSITIONS_ROOT = new URL("./", window.location.href).href;
const DATA_URL = `${POSITIONS_ROOT}data/positions.json`;
const STORAGE_KEY = "yanagi-backgammon-quiz-progress-v1";
const SETTINGS_KEY = "yanagi-backgammon-quiz-settings-v1";
const DAILY_STORAGE_KEY = "yanagi-backgammon-quiz-daily-v1";
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

const KIND_LABELS = {
  checker: "Checker Play",
  double: "Double Action",
  take: "Take Action",
};

const state = {
  positions: [],
  currentKind: "checker",
  current: null,
  answered: false,
  progress: {},
  daily: { day: "", correct: 0, wrong: 0 },
  dailyResetTimer: null,
  dataVersion: "",
};

const elements = {
  card: document.getElementById("quiz-card"),
  empty: document.getElementById("empty-state"),
  tabs: [...document.querySelectorAll("[data-kind]")],
  counts: [...document.querySelectorAll("[data-count]")],
  challengeOnly: document.getElementById("challenge-only"),
  challengeCount: document.getElementById("challenge-count"),
  board: document.getElementById("board-image"),
  positionCorrect: document.getElementById("position-correct"),
  positionWrong: document.getElementById("position-wrong"),
  answerButton: document.getElementById("answer-button"),
  answerPanel: document.getElementById("answer-panel"),
  actionAnalysis: document.getElementById("action-analysis"),
  summaryAnalysis: document.getElementById("summary-analysis"),
  judgeButtons: document.getElementById("judge-buttons"),
  correctButton: document.getElementById("correct-button"),
  wrongButton: document.getElementById("wrong-button"),
  nextButton: document.getElementById("next-button"),
  sourceFile: document.getElementById("source-file"),
  totalCorrect: document.getElementById("total-correct"),
  totalWrong: document.getElementById("total-wrong"),
  todayCorrect: document.getElementById("today-correct"),
  todayWrong: document.getElementById("today-wrong"),
};

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function loadJSON(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

function saveProgress() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    kind: state.currentKind,
    challengeOnly: elements.challengeOnly.checked,
  }));
}

function recordFor(id) {
  const raw = state.progress[id] || {};
  return {
    correct: Math.max(0, Number(raw.correct) || 0),
    wrong: Math.max(0, Number(raw.wrong) || 0),
  };
}

function isChallenge(position) {
  const record = recordFor(position.id);
  return record.correct === 0 || record.correct < record.wrong;
}

function decisionKind(position) {
  if (position.decisionKind) return position.decisionKind;
  if (position.decisionType === "checker") return "checker";
  return null;
}

function positionsForKind(kind) {
  return state.positions.filter((position) => decisionKind(position) === kind);
}

function activePool() {
  let pool = positionsForKind(state.currentKind);
  if (elements.challengeOnly.checked) {
    pool = pool.filter(isChallenge);
  }
  return pool;
}

function randomPosition(pool, avoidId = null) {
  if (!pool.length) return null;
  const choices = pool.length > 1 && avoidId
    ? pool.filter((position) => position.id !== avoidId)
    : pool;
  return choices[Math.floor(Math.random() * choices.length)] || pool[0];
}

function absoluteBoardUrl(position) {
  const path = position.quizBoardImage || position.boardImage || "";
  const url = new URL(path, POSITIONS_ROOT);
  if (state.dataVersion) url.searchParams.set("v", state.dataVersion);
  return url.href;
}

function formatError(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return `−${Math.abs(number).toFixed(3)}`;
}

function formatSignedEquity(value) {
  if (value == null || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) < 0.0005) return "";
  const sign = number > 0 ? "+" : "−";
  return `${sign}${Math.abs(number).toFixed(3)}`;
}

function formatPercent(value) {
  if (value == null || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${(number * 100).toFixed(1)}%`;
}

function awayText(position, away) {
  if (Number(away) === 1 && position.isCrawford) return "Cr";
  if (Number(away) === 1 && position.isPostCrawford) return "PC";
  return `${Math.max(0, Number(away) || 0)}a`;
}

function cubeStateText(position, cubeValue = position.cubeValue) {
  if (position.isCrawford) return "Cr";
  return String(cubeValue ?? "—");
}

function pipCounts(position) {
  const points = position.decisionKind === "take" && Array.isArray(position.quizPosition)
    ? position.quizPosition
    : (Array.isArray(position.position) ? position.position : []);
  let black = 0;
  let white = 0;
  for (let point = 1; point <= 24; point += 1) {
    const value = Number(points[point] || 0);
    if (value > 0) black += point * value;
    if (value < 0) white += (25 - point) * -value;
  }
  black += 25 * Math.max(Number(points[25] || 0), 0);
  white += 25 * Math.max(-Number(points[0] || 0), 0);
  return { black, white };
}

function statLine(label, value, extraClass = "", valueClass = "") {
  return `<div class="stat-line ${extraClass}"><span class="stat-label">${escapeHTML(label)}</span><span class="stat-value ${valueClass}">${value}</span></div>`;
}

function pipDisplayValues(pips) {
  const black = Number(pips?.black);
  const white = Number(pips?.white);
  const values = {
    black: Number.isFinite(black) ? String(black) : "—",
    white: Number.isFinite(white) ? String(white) : "—",
  };

  if (!Number.isFinite(black) || !Number.isFinite(white) || black <= 0 || white <= 0 || black === white) {
    return values;
  }

  const lower = Math.min(black, white);
  const higher = Math.max(black, white);
  const differencePercent = ((higher / lower) - 1) * 100;
  const suffix = ` (${differencePercent.toFixed(1)}%)`;

  if (black < white) values.black += suffix;
  if (white < black) values.white += suffix;
  return values;
}

function errorToneClass(value, { lossMagnitude = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  if (!lossMagnitude && number >= 0) return "";

  const roundedMagnitude = Math.round((Math.abs(number) + Number.EPSILON) * 1000) / 1000;
  if (roundedMagnitude >= 0.050) return "error-severe";
  if (roundedMagnitude >= 0.020) return "error-warning";
  return "";
}

function displayedPlayedAction(position) {
  const played = String(position.playedAction || "").trim();
  if (position.decisionKind !== "take") return played;

  const lower = played.toLowerCase();
  if (lower === "take" || lower.endsWith("/take")) return "Take";
  if (lower === "pass" || lower === "drop" || lower.endsWith("/pass") || lower.endsWith("/drop")) return "Pass";
  return played;
}

function actionAnalysisHTML(position) {
  const playedAction = displayedPlayedAction(position);
  const isPlayed = (action) => playedAction && String(action || "").trim() === playedAction;

  if (position.decisionType === "cube") {
    if (position.decisionKind === "take" && Array.isArray(position.quizCandidates)) {
      const choices = position.quizCandidates
        .filter((candidate) => candidate && candidate.action)
        .slice(0, 2);
      return `<div class="action-list">${choices.map((candidate, index) => {
        const best = index === 0;
        const tone = best ? "" : errorToneClass(candidate.equityDifference);
        return `
        <div class="action-option ${best ? "is-best" : ""}">
          <span class="action-text ${isPlayed(candidate.action) ? "is-played" : ""}">${escapeHTML(candidate.action || "—")}</span>
          <span class="action-error ${best ? "best-marker" : tone}">${escapeHTML(best ? "BEST" : formatSignedEquity(candidate.equityDifference))}</span>
        </div>`;
      }).join("")}</div>`;
    }

    const outcomes = (Array.isArray(position.candidates) ? position.candidates : [])
      .filter((candidate) => candidate && candidate.action)
      .slice(0, 3);
    const hasPlayedOutcome = outcomes.some((candidate) => isPlayed(candidate.action));
    const bestAction = position.bestAction || "—";
    const rows = [
      `<div class="action-option is-best"><span class="action-text ${!hasPlayedOutcome && isPlayed(bestAction) ? "is-played" : ""}">${escapeHTML(bestAction)}</span><span class="action-error best-marker">BEST</span></div>`,
      ...outcomes.map((candidate) => {
        const tone = errorToneClass(candidate.equityDifference);
        return `
        <div class="action-option">
          <span class="action-text ${isPlayed(candidate.action) ? "is-played" : ""}">${escapeHTML(candidate.action || "—")}</span>
          <span class="action-error ${tone}">${escapeHTML(formatSignedEquity(candidate.equityDifference))}</span>
        </div>`;
      }),
    ];
    return `<div class="action-list">${rows.join("")}</div>`;
  }

  const ordered = (Array.isArray(position.candidates) ? position.candidates : [])
    .filter((candidate) => {
      const loss = Number(candidate?.equityLoss);
      return Number.isFinite(loss) && loss >= 0 && loss < 100;
    })
    .slice()
    .sort((a, b) => Number(a.rank || 0) - Number(b.rank || 0));

  // Checker Play shows every analysed move exported by XG, not just the top three.
  const candidates = ordered.slice();
  if (!candidates.length) candidates.push({ rank: 1, action: position.bestAction, equityLoss: 0 });

  if (playedAction && !candidates.some((candidate) => String(candidate.action || "").trim() === playedAction)) {
    const playedCandidate = ordered.find((candidate) => String(candidate.action || "").trim() === playedAction);
    const candidateLoss = Number(playedCandidate?.equityLoss);
    candidates.push({
      rank: playedCandidate?.rank ?? (candidates.length + 1),
      action: playedAction,
      equityLoss: Number.isFinite(candidateLoss) && candidateLoss >= 0 && candidateLoss < 100
        ? candidateLoss
        : position.errorLoss,
    });
  }

  return `<div class="action-list">${candidates.map((candidate, index) => {
    const best = index === 0 || Number(candidate.rank) === 1;
    const tone = best ? "" : errorToneClass(candidate.equityLoss, { lossMagnitude: true });
    return `
      <div class="action-option ${best ? "is-best" : ""}">
        <span class="action-text ${isPlayed(candidate.action) ? "is-played" : ""}">${escapeHTML(candidate.action || "—")}</span>
        <span class="action-error ${best ? "best-marker" : tone}">${escapeHTML(best ? "BEST" : formatError(candidate.equityLoss))}</span>
      </div>`;
  }).join("")}</div>`;
}

function summaryAnalysisHTML(position) {
  const pips = pipCounts(position);
  const pipDisplay = pipDisplayValues(pips);
  const isTake = position.decisionKind === "take";
  const rawPlayerScore = isTake && position.quizPlayerScore != null ? position.quizPlayerScore : position.playerScore;
  const rawOpponentScore = isTake && position.quizOpponentScore != null ? position.quizOpponentScore : position.opponentScore;
  const rawCubeValue = isTake && position.quizCubeValue != null ? position.quizCubeValue : position.cubeValue;
  const winRate = isTake && position.quizWinRate != null ? position.quizWinRate : position.winRate;
  const loseRate = isTake && position.quizLoseRate != null ? position.quizLoseRate : position.loseRate;
  const gammonWinRate = isTake && position.quizGammonWinRate != null ? position.quizGammonWinRate : position.gammonWinRate;
  const gammonLoseRate = isTake && position.quizGammonLoseRate != null ? position.quizGammonLoseRate : position.gammonLoseRate;
  const backgammonWinRate = isTake && position.quizBackgammonWinRate != null ? position.quizBackgammonWinRate : position.backgammonWinRate;
  const backgammonLoseRate = isTake && position.quizBackgammonLoseRate != null ? position.quizBackgammonLoseRate : position.backgammonLoseRate;

  const rawMatchLength = Number(position.matchLength) || 0;
  const isDmp = rawMatchLength === 1;
  const isUnlimited = rawMatchLength === 0 || rawMatchLength >= 99999;

  // Display conventions:
  // - 1-point match (DMP): ML 1 / CB 1 / BK 0 (1a) / WH 0 (1a)
  // - Unlimited (money game): ML 0 / BK 0 / WH 0; the live cube value remains meaningful.
  const matchLength = isUnlimited ? 0 : rawMatchLength;
  const playerScore = isDmp || isUnlimited ? 0 : Number(rawPlayerScore || 0);
  const opponentScore = isDmp || isUnlimited ? 0 : Number(rawOpponentScore || 0);
  const cubeValue = isDmp ? 1 : rawCubeValue;
  const playerAway = Math.max(0, matchLength - playerScore);
  const opponentAway = Math.max(0, matchLength - opponentScore);
  const playerScoreText = isDmp
    ? "0 (1a)"
    : isUnlimited
      ? "0"
      : `${playerScore} (${awayText(position, playerAway)})`;
  const opponentScoreText = isDmp
    ? "0 (1a)"
    : isUnlimited
      ? "0"
      : `${opponentScore} (${awayText(position, opponentAway)})`;

  const blackWin = Number(winRate);
  const whiteWin = Number(loseRate);
  const blackGammon = Number(gammonWinRate);
  const whiteGammon = Number(gammonLoseRate);
  const blackBackgammon = Number(backgammonWinRate);
  const whiteBackgammon = Number(backgammonLoseRate);
  const blackWidth = Number.isFinite(blackWin) ? Math.max(0, Math.min(100, blackWin * 100)) : 50;
  const whiteWidth = Number.isFinite(whiteWin) ? Math.max(0, Math.min(100, whiteWin * 100)) : 100 - blackWidth;
  // Hide G/BG overlays below 1%. Exactly 1.0% or more remains visible.
  const blackOverlay = Number.isFinite(blackGammon) && blackGammon >= 0.01
    ? Math.max(0, blackGammon * 100)
    : 0;
  const whiteOverlay = Number.isFinite(whiteGammon) && whiteGammon >= 0.01
    ? Math.max(0, whiteGammon * 100)
    : 0;
  const blackBackgammonOverlay = Number.isFinite(blackBackgammon) && blackBackgammon >= 0.01
    ? Math.max(0, blackBackgammon * 100)
    : 0;
  const whiteBackgammonOverlay = Number.isFinite(whiteBackgammon) && whiteBackgammon >= 0.01
    ? Math.max(0, whiteBackgammon * 100)
    : 0;

  return `
    <div class="summary-text-scroll" aria-label="Game information">
      <div class="summary-text-grid">
        ${statLine("ML", escapeHTML(matchLength))}
        ${statLine("BK", escapeHTML(playerScoreText), "side-black")}
        ${statLine("WH", escapeHTML(opponentScoreText), "side-white")}

        ${statLine("CB", escapeHTML(isDmp ? "1" : cubeStateText(position, cubeValue)))}
        ${statLine("PIP", escapeHTML(pipDisplay.black), "", "answer-only-value")}
        ${statLine("PIP", escapeHTML(pipDisplay.white), "", "answer-only-value")}

        <div aria-hidden="true"></div>
        ${statLine("W", escapeHTML(formatPercent(winRate)), "", "answer-only-value")}
        ${statLine("W", escapeHTML(formatPercent(loseRate)), "", "answer-only-value")}

        <div aria-hidden="true"></div>
        ${statLine("GW", escapeHTML(formatPercent(gammonWinRate)), "", "answer-only-value")}
        ${statLine("GW", escapeHTML(formatPercent(gammonLoseRate)), "", "answer-only-value")}

        <div aria-hidden="true"></div>
        ${statLine("BG", escapeHTML(formatPercent(backgammonWinRate)), "", "answer-only-value")}
        ${statLine("BG", escapeHTML(formatPercent(backgammonLoseRate)), "", "answer-only-value")}
      </div>
    </div>
    <div class="win-scale" aria-hidden="true">
      <span style="left:30%">30%</span>
      <span style="left:50%">50%</span>
      <span style="left:70%">70%</span>
      <span class="win-boundary-marker answer-only-chart" style="left:${blackWidth.toFixed(3)}%">▼</span>
    </div>
    <div class="win-bar" aria-hidden="true">
      <span class="win-grid-line" style="left:10%"></span>
      <span class="win-grid-line" style="left:20%"></span>
      <span class="win-grid-line" style="left:30%"></span>
      <span class="win-grid-line" style="left:40%"></span>
      <span class="win-grid-line is-mid" style="left:50%"></span>
      <span class="win-grid-line" style="left:60%"></span>
      <span class="win-grid-line" style="left:70%"></span>
      <span class="win-grid-line" style="left:80%"></span>
      <span class="win-grid-line" style="left:90%"></span>
      <div class="win-black answer-only-chart" style="width:${blackWidth.toFixed(3)}%"></div>
      <div class="win-white answer-only-chart" style="width:${whiteWidth.toFixed(3)}%"></div>
      <div class="win-black-gammon answer-only-chart" style="width:${Math.min(blackOverlay, blackWidth).toFixed(3)}%"></div>
      <div class="win-white-gammon answer-only-chart" style="width:${Math.min(whiteOverlay, whiteWidth).toFixed(3)}%"></div>
      <div class="win-black-backgammon answer-only-chart" style="width:${Math.min(blackBackgammonOverlay, blackOverlay, blackWidth).toFixed(3)}%"></div>
      <div class="win-white-backgammon answer-only-chart" style="width:${Math.min(whiteBackgammonOverlay, whiteOverlay, whiteWidth).toFixed(3)}%"></div>
    </div>`;
}

function totalRecord() {
  let correct = 0;
  let wrong = 0;
  Object.values(state.progress).forEach((raw) => {
    correct += Math.max(0, Number(raw?.correct) || 0);
    wrong += Math.max(0, Number(raw?.wrong) || 0);
  });
  return { correct, wrong };
}

function quizDayKey(date = new Date()) {
  const shifted = new Date(date.getTime());
  shifted.setHours(shifted.getHours() - 4);
  const year = shifted.getFullYear();
  const month = String(shifted.getMonth() + 1).padStart(2, "0");
  const day = String(shifted.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function saveDaily() {
  localStorage.setItem(DAILY_STORAGE_KEY, JSON.stringify(state.daily));
}

function ensureDailyRecord({ seedFromTotal = false } = {}) {
  const day = quizDayKey();
  if (state.daily?.day === day) return false;

  const isFirstSetup = !state.daily?.day;
  const seed = isFirstSetup && seedFromTotal ? totalRecord() : { correct: 0, wrong: 0 };
  state.daily = {
    day,
    correct: seed.correct,
    wrong: seed.wrong,
  };
  saveDaily();
  return true;
}

function updateToday() {
  ensureDailyRecord();
  elements.todayCorrect.textContent = String(Math.max(0, Number(state.daily.correct) || 0));
  elements.todayWrong.textContent = String(Math.max(0, Number(state.daily.wrong) || 0));
}

function scheduleDailyReset() {
  if (state.dailyResetTimer) window.clearTimeout(state.dailyResetTimer);
  const now = new Date();
  const next = new Date(now);
  next.setHours(4, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = Math.max(1000, next.getTime() - now.getTime() + 100);
  state.dailyResetTimer = window.setTimeout(() => {
    ensureDailyRecord();
    updateToday();
    scheduleDailyReset();
  }, delay);
}

function updatePositionRecord() {
  if (!state.current) return;
  const record = recordFor(state.current.id);
  elements.positionCorrect.textContent = String(record.correct);
  elements.positionWrong.textContent = String(record.wrong);
}

function updateTotals() {
  const total = totalRecord();
  elements.totalCorrect.textContent = String(total.correct);
  elements.totalWrong.textContent = String(total.wrong);
  updateToday();
}

function updateCounts() {
  elements.counts.forEach((element) => {
    const kind = element.dataset.count;
    element.textContent = String(positionsForKind(kind).length);
  });
  const currentKindPositions = positionsForKind(state.currentKind);
  elements.challengeCount.textContent = String(currentKindPositions.filter(isChallenge).length);
}

function populateAnswerData() {
  if (!state.current) return;
  elements.actionAnalysis.innerHTML = actionAnalysisHTML(state.current);
  elements.summaryAnalysis.innerHTML = summaryAnalysisHTML(state.current);
  elements.sourceFile.textContent = state.current.sourceFile || "";
}

function resetSummaryTextScroll() {
  const scroller = elements.summaryAnalysis.querySelector(".summary-text-scroll");
  if (scroller) scroller.scrollTop = 0;
}

function resetAnswerUI() {
  state.answered = false;
  elements.card.classList.remove("is-answered");
  elements.answerPanel.hidden = false;
  elements.answerButton.hidden = false;
  elements.judgeButtons.hidden = true;
  elements.nextButton.hidden = false;
  elements.correctButton.setAttribute("aria-pressed", "false");
  elements.wrongButton.setAttribute("aria-pressed", "false");
  elements.actionAnalysis.scrollTop = 0;
  elements.summaryAnalysis.scrollTop = 0;
  resetSummaryTextScroll();
}

function renderCurrent() {
  const pool = activePool();
  updateCounts();
  updateTotals();

  if (!state.current || !pool.some((position) => position.id === state.current.id)) {
    state.current = randomPosition(pool, state.current?.id || null);
  }

  if (!state.current) {
    elements.card.hidden = true;
    elements.empty.hidden = false;
    elements.sourceFile.textContent = "";
    elements.sourceFile.hidden = true;
    return;
  }

  elements.card.hidden = false;
  elements.sourceFile.hidden = false;
  elements.empty.hidden = true;
  elements.board.src = absoluteBoardUrl(state.current);
  elements.board.alt = `${KIND_LABELS[state.currentKind]} quiz position`;
  updatePositionRecord();
  populateAnswerData();
  resetAnswerUI();
}

function recordResult(result) {
  if (!state.current || (result !== "correct" && result !== "wrong")) return false;

  const record = recordFor(state.current.id);
  if (result === "correct") record.correct += 1;
  else record.wrong += 1;
  state.progress[state.current.id] = record;
  saveProgress();

  ensureDailyRecord();
  if (result === "correct") state.daily.correct += 1;
  else state.daily.wrong += 1;
  saveDaily();
  return true;
}

function selectNext() {
  const previousId = state.current?.id || null;
  state.current = randomPosition(activePool(), previousId);
  renderCurrent();
}

function showAnswer() {
  if (!state.current) return;
  state.answered = true;
  elements.actionAnalysis.scrollTop = 0;
  elements.summaryAnalysis.scrollTop = 0;
  resetSummaryTextScroll();
  elements.card.classList.add("is-answered");
  elements.answerButton.hidden = true;
  elements.judgeButtons.hidden = false;
  elements.answerPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function judge(result) {
  if (!state.current || !state.answered) return;
  if (!recordResult(result)) return;
  selectNext();
}

function setKind(kind) {
  if (!KIND_LABELS[kind]) return;
  state.currentKind = kind;
  state.current = null;
  elements.tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.kind === kind));
  saveSettings();
  renderCurrent();
}

function installSmartphoneZoomGuard() {
  const smartphone = window.matchMedia("(max-width: 760px)");
  const preventGesture = (event) => {
    if (smartphone.matches) event.preventDefault();
  };

  ["gesturestart", "gesturechange", "gestureend", "dblclick"].forEach((type) => {
    document.addEventListener(type, preventGesture, { passive: false });
  });

  document.addEventListener("touchmove", (event) => {
    if (smartphone.matches && event.touches.length > 1) event.preventDefault();
  }, { passive: false });

  let lastTouchEnd = 0;
  let lastTouchTarget = null;
  document.addEventListener("touchend", (event) => {
    if (!smartphone.matches) return;

    const now = Date.now();
    const sameTarget = event.target === lastTouchTarget;
    if (sameTarget && now - lastTouchEnd < 350) {
      event.preventDefault();
    }
    lastTouchEnd = now;
    lastTouchTarget = event.target;
  }, { passive: false });
}

function installEvents() {
  elements.tabs.forEach((tab) => {
    tab.addEventListener("click", () => setKind(tab.dataset.kind));
  });
  elements.challengeOnly.addEventListener("change", () => {
    state.current = null;
    saveSettings();
    renderCurrent();
  });
  elements.answerButton.addEventListener("click", showAnswer);
  elements.correctButton.addEventListener("click", () => judge("correct"));
  elements.wrongButton.addEventListener("click", () => judge("wrong"));
  elements.nextButton.addEventListener("click", selectNext);
}

async function syncPositions({ initial = false } = {}) {
  const response = await fetch(`${DATA_URL}?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const payload = await response.json();
  const nextVersion = String(payload.meta?.generatedAt || payload.meta?.positionCount || Date.now());
  if (!initial && nextVersion === state.dataVersion) return false;

  const previousId = state.current?.id || null;
  state.positions = (payload.positions || []).filter((position) => decisionKind(position));
  state.dataVersion = nextVersion;

  const theme = payload.meta?.themeColor;
  if (theme) document.documentElement.style.setProperty("--theme", theme);

  if (previousId) {
    state.current = state.positions.find((position) => position.id === previousId) || null;
  }
  renderCurrent();
  return true;
}

async function refreshPositionsSilently() {
  try {
    await syncPositions();
  } catch (error) {
    console.warn("positions sync failed", error);
  }
}

async function start() {
  state.progress = loadJSON(STORAGE_KEY, {});
  state.daily = loadJSON(DAILY_STORAGE_KEY, { day: "", correct: 0, wrong: 0 });
  ensureDailyRecord({ seedFromTotal: true });
  const settings = loadJSON(SETTINGS_KEY, {});
  if (KIND_LABELS[settings.kind]) state.currentKind = settings.kind;
  elements.challengeOnly.checked = Boolean(settings.challengeOnly);
  elements.tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.kind === state.currentKind));
  installSmartphoneZoomGuard();
  installEvents();
  scheduleDailyReset();

  try {
    await syncPositions({ initial: true });
  } catch (error) {
    console.error(error);
    elements.card.hidden = true;
    elements.empty.hidden = false;
    elements.empty.innerHTML = "<strong>Unable to load position data.</strong><span>Check the GitHub Pages deployment and build status for the positions repository.</span>";
  }

  window.setInterval(refreshPositionsSilently, SYNC_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      if (ensureDailyRecord()) updateToday();
      scheduleDailyReset();
      refreshPositionsSilently();
    }
  });
}

start();
