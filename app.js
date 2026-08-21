"use strict";

const POSITIONS_ROOT = "https://yanagibackgammon.github.io/positions/";
const DATA_URL = `${POSITIONS_ROOT}data/positions.json`;
const STORAGE_KEY = "yanagi-backgammon-quiz-progress-v1";
const SETTINGS_KEY = "yanagi-backgammon-quiz-settings-v1";
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
  judged: false,
  progress: {},
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
  answerData: [...document.querySelectorAll("[data-answer-data]")],
  actionAnalysis: document.getElementById("action-analysis"),
  summaryAnalysis: document.getElementById("summary-analysis"),
  judgeButtons: document.getElementById("judge-buttons"),
  correctButton: document.getElementById("correct-button"),
  wrongButton: document.getElementById("wrong-button"),
  judgedMessage: document.getElementById("judged-message"),
  nextButton: document.getElementById("next-button"),
  sourceFile: document.getElementById("source-file"),
  totalCorrect: document.getElementById("total-correct"),
  totalWrong: document.getElementById("total-wrong"),
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

function actionAnalysisHTML(position) {
  if (position.decisionType === "cube") {
    if (position.decisionKind === "take" && Array.isArray(position.quizCandidates)) {
      const choices = position.quizCandidates
        .filter((candidate) => candidate && candidate.action)
        .slice(0, 2);
      return `<div class="action-list">${choices.map((candidate, index) => `
        <div class="action-option ${index === 0 ? "is-best" : ""}">
          <span class="action-text">${escapeHTML(candidate.action || "—")}</span>
          <span class="action-error ${index === 0 ? "best-marker" : ""}">${escapeHTML(index === 0 ? "BEST" : formatSignedEquity(candidate.equityDifference))}</span>
        </div>`).join("")}</div>`;
    }

    const outcomes = (Array.isArray(position.candidates) ? position.candidates : [])
      .filter((candidate) => candidate && candidate.action)
      .slice(0, 3);
    const rows = [
      `<div class="action-option is-best"><span class="action-text">${escapeHTML(position.bestAction || "—")}</span><span class="action-error best-marker">BEST</span></div>`,
      ...outcomes.map((candidate) => `
        <div class="action-option">
          <span class="action-text">${escapeHTML(candidate.action || "—")}</span>
          <span class="action-error">${escapeHTML(formatSignedEquity(candidate.equityDifference))}</span>
        </div>`),
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
  const candidates = ordered.slice(0, 3);
  if (!candidates.length) candidates.push({ rank: 1, action: position.bestAction, equityLoss: 0 });

  const playedAction = String(position.playedAction || "").trim();
  if (playedAction && !candidates.some((candidate) => String(candidate.action || "").trim() === playedAction)) {
    const playedCandidate = ordered.find((candidate) => String(candidate.action || "").trim() === playedAction);
    const candidateLoss = Number(playedCandidate?.equityLoss);
    candidates.push({
      rank: playedCandidate?.rank ?? 4,
      action: playedAction,
      equityLoss: Number.isFinite(candidateLoss) && candidateLoss >= 0 && candidateLoss < 100
        ? candidateLoss
        : position.errorLoss,
    });
  }

  return `<div class="action-list">${candidates.map((candidate, index) => {
    const isBest = index === 0 || Number(candidate.rank) === 1;
    return `
      <div class="action-option ${isBest ? "is-best" : ""}">
        <span class="action-text">${escapeHTML(candidate.action || "—")}</span>
        <span class="action-error ${isBest ? "best-marker" : ""}">${escapeHTML(isBest ? "BEST" : formatError(candidate.equityLoss))}</span>
      </div>`;
  }).join("")}</div>`;
}

function summaryAnalysisHTML(position) {
  const pips = pipCounts(position);
  const pipDisplay = pipDisplayValues(pips);
  const isTake = position.decisionKind === "take";
  const playerScore = isTake && position.quizPlayerScore != null ? position.quizPlayerScore : position.playerScore;
  const opponentScore = isTake && position.quizOpponentScore != null ? position.quizOpponentScore : position.opponentScore;
  const cubeValue = isTake && position.quizCubeValue != null ? position.quizCubeValue : position.cubeValue;
  const winRate = isTake && position.quizWinRate != null ? position.quizWinRate : position.winRate;
  const loseRate = isTake && position.quizLoseRate != null ? position.quizLoseRate : position.loseRate;
  const gammonWinRate = isTake && position.quizGammonWinRate != null ? position.quizGammonWinRate : position.gammonWinRate;
  const gammonLoseRate = isTake && position.quizGammonLoseRate != null ? position.quizGammonLoseRate : position.gammonLoseRate;
  const matchLength = Number(position.matchLength) || 0;
  const playerAway = Math.max(0, matchLength - Number(playerScore || 0));
  const opponentAway = Math.max(0, matchLength - Number(opponentScore || 0));
  const blackWin = Number(winRate);
  const whiteWin = Number(loseRate);
  const blackGammon = Number(gammonWinRate);
  const whiteGammon = Number(gammonLoseRate);
  const blackWidth = Number.isFinite(blackWin) ? Math.max(0, Math.min(100, blackWin * 100)) : 50;
  const whiteWidth = Number.isFinite(whiteWin) ? Math.max(0, Math.min(100, whiteWin * 100)) : 100 - blackWidth;
  const blackOverlay = Number.isFinite(blackGammon) ? Math.max(0, blackGammon * 100) : 0;
  const whiteOverlay = Number.isFinite(whiteGammon) ? Math.max(0, whiteGammon * 100) : 0;

  return `
    <div class="summary-top">
      <div class="summary-meta">
        ${statLine("ML", escapeHTML(position.matchLength))}
        ${statLine("CB", escapeHTML(cubeStateText(position, cubeValue)))}
      </div>
      <div class="summary-side">
        ${statLine("BK", `${escapeHTML(playerScore)} (${escapeHTML(awayText(position, playerAway))})`)}
        ${statLine("PIP", escapeHTML(pipDisplay.black), "", "answer-only-value")}
        ${statLine("W", escapeHTML(formatPercent(winRate)), "", "answer-only-value")}
        ${statLine("GW", escapeHTML(formatPercent(gammonWinRate)), "", "answer-only-value")}
      </div>
      <div class="summary-side">
        ${statLine("WH", `${escapeHTML(opponentScore)} (${escapeHTML(awayText(position, opponentAway))})`)}
        ${statLine("PIP", escapeHTML(pipDisplay.white), "", "answer-only-value")}
        ${statLine("W", escapeHTML(formatPercent(loseRate)), "", "answer-only-value")}
        ${statLine("GW", escapeHTML(formatPercent(gammonLoseRate)), "", "answer-only-value")}
      </div>
    </div>
    <div class="win-scale" aria-hidden="true">
      <span style="left:30%">30%</span>
      <span style="left:50%">50%</span>
      <span style="left:70%">70%</span>
      <span class="win-boundary-marker answer-only-chart" style="left:${blackWidth.toFixed(3)}%">▼</span>
    </div>
    <div class="win-bar" aria-hidden="true">
      <div class="win-black answer-only-chart" style="width:${blackWidth.toFixed(3)}%"></div>
      <div class="win-white answer-only-chart" style="width:${whiteWidth.toFixed(3)}%"></div>
      <div class="win-black-gammon answer-only-chart" style="width:${Math.min(blackOverlay, blackWidth).toFixed(3)}%"></div>
      <div class="win-white-gammon answer-only-chart" style="width:${Math.min(whiteOverlay, whiteWidth).toFixed(3)}%"></div>
    </div>`;
}

function updatePositionRecord() {
  if (!state.current) return;
  const record = recordFor(state.current.id);
  elements.positionCorrect.textContent = String(record.correct);
  elements.positionWrong.textContent = String(record.wrong);
}

function updateTotals() {
  let correct = 0;
  let wrong = 0;
  Object.values(state.progress).forEach((raw) => {
    correct += Math.max(0, Number(raw?.correct) || 0);
    wrong += Math.max(0, Number(raw?.wrong) || 0);
  });
  elements.totalCorrect.textContent = String(correct);
  elements.totalWrong.textContent = String(wrong);
}

function updateCounts() {
  elements.counts.forEach((element) => {
    const kind = element.dataset.count;
    element.textContent = String(positionsForKind(kind).length);
  });
  const currentKindPositions = positionsForKind(state.currentKind);
  elements.challengeCount.textContent = String(currentKindPositions.filter(isChallenge).length);
}

function setAnswerDataVisible(visible) {
  elements.answerData.forEach((element) => {
    element.classList.toggle("is-concealed", !visible);
    element.setAttribute("aria-hidden", visible ? "false" : "true");
  });
}

function populateAnswerData() {
  if (!state.current) return;
  elements.actionAnalysis.innerHTML = actionAnalysisHTML(state.current);
  elements.summaryAnalysis.innerHTML = summaryAnalysisHTML(state.current);
  elements.sourceFile.textContent = state.current.sourceFile || "";
}

function resetAnswerUI() {
  state.answered = false;
  elements.card.classList.remove("is-answered");
  state.judged = false;
  elements.answerPanel.hidden = false;
  elements.answerButton.hidden = false;
  elements.judgeButtons.hidden = true;
  elements.correctButton.disabled = false;
  elements.wrongButton.disabled = false;
  elements.judgedMessage.hidden = true;
  elements.judgedMessage.textContent = "";
  elements.nextButton.hidden = true;
  setAnswerDataVisible(false);
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

function selectNext() {
  const previousId = state.current?.id || null;
  state.current = randomPosition(activePool(), previousId);
  renderCurrent();
}

function showAnswer() {
  if (!state.current) return;
  state.answered = true;
  elements.card.classList.add("is-answered");
  elements.answerButton.hidden = true;
  elements.judgeButtons.hidden = false;
  setAnswerDataVisible(true);
  elements.answerPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function judge(result) {
  if (!state.current || !state.answered || state.judged) return;
  const record = recordFor(state.current.id);
  if (result === "correct") record.correct += 1;
  else record.wrong += 1;
  state.progress[state.current.id] = record;
  saveProgress();

  state.judged = true;
  elements.correctButton.disabled = true;
  elements.wrongButton.disabled = true;
  elements.judgedMessage.hidden = false;
  elements.judgedMessage.textContent = result === "correct"
    ? "Recorded as correct."
    : "Recorded as incorrect.";
  elements.nextButton.hidden = false;
  updatePositionRecord();
  updateCounts();
  updateTotals();
}

function setKind(kind) {
  if (!KIND_LABELS[kind]) return;
  state.currentKind = kind;
  state.current = null;
  elements.tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.kind === kind));
  saveSettings();
  renderCurrent();
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
  const settings = loadJSON(SETTINGS_KEY, {});
  if (KIND_LABELS[settings.kind]) state.currentKind = settings.kind;
  elements.challengeOnly.checked = Boolean(settings.challengeOnly);
  elements.tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.kind === state.currentKind));
  installEvents();

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
    if (!document.hidden) refreshPositionsSilently();
  });
}

start();
