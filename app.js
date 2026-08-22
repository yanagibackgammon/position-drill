"use strict";

const POSITIONS_ROOT = new URL("./", window.location.href).href;
const DATA_URL = `${POSITIONS_ROOT}data/positions.json`;
const STORAGE_KEY = "yanagi-backgammon-quiz-progress-v1";
const SETTINGS_KEY = "yanagi-backgammon-quiz-settings-v1";
const DAILY_STORAGE_KEY = "yanagi-backgammon-quiz-daily-v1";
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const BOARD_PRELOAD_COUNT = 3;
const BOARD_PRELOAD_CACHE_LIMIT = 8;
const LOCAL_DB_NAME = "position-drill-local-v1";
const LOCAL_DB_STORE = "records";
const NEW_POSITION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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
  boardQueue: [],
  filters: { task: false, new: false },
};

const elements = {
  card: document.getElementById("quiz-card"),
  empty: document.getElementById("empty-state"),
  tabs: [...document.querySelectorAll("[data-kind]")],
  counts: [...document.querySelectorAll("[data-count]")],
  filterButtons: [...document.querySelectorAll("[data-filter]")],
  taskCount: document.getElementById("task-count"),
  newCount: document.getElementById("new-count"),
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

function saveLocalJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`localStorage write failed: ${key}`, error);
  }
}

function openLocalDB() {
  return new Promise((resolve) => {
    if (!("indexedDB" in window)) {
      resolve(null);
      return;
    }

    const request = indexedDB.open(LOCAL_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LOCAL_DB_STORE)) {
        db.createObjectStore(LOCAL_DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function readLocalDB(key) {
  const db = await openLocalDB();
  if (!db) return null;

  return new Promise((resolve) => {
    const transaction = db.transaction(LOCAL_DB_STORE, "readonly");
    const request = transaction.objectStore(LOCAL_DB_STORE).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => resolve(null);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => db.close();
  });
}

async function writeLocalDB(key, value) {
  const db = await openLocalDB();
  if (!db) return;

  await new Promise((resolve) => {
    const transaction = db.transaction(LOCAL_DB_STORE, "readwrite");
    transaction.objectStore(LOCAL_DB_STORE).put(value, key);
    transaction.oncomplete = resolve;
    transaction.onerror = resolve;
    transaction.onabort = resolve;
  });

  db.close();
}

function mirrorLocalDB(key, value) {
  writeLocalDB(key, value).catch(() => {});
}

function mergeProgress(primary, backup) {
  const merged = { ...(backup || {}), ...(primary || {}) };
  const keys = new Set([
    ...Object.keys(primary || {}),
    ...Object.keys(backup || {}),
  ]);

  keys.forEach((key) => {
    const a = primary?.[key] || {};
    const b = backup?.[key] || {};
    merged[key] = {
      correct: Math.max(0, Number(a.correct) || 0, Number(b.correct) || 0),
      wrong: Math.max(0, Number(a.wrong) || 0, Number(b.wrong) || 0),
    };
  });

  return merged;
}

async function loadProgress() {
  const local = loadJSON(STORAGE_KEY, {});
  const backup = await readLocalDB(STORAGE_KEY);
  const merged = mergeProgress(local, backup && typeof backup === "object" ? backup : {});
  saveLocalJSON(STORAGE_KEY, merged);
  mirrorLocalDB(STORAGE_KEY, merged);
  return merged;
}

function saveProgress() {
  saveLocalJSON(STORAGE_KEY, state.progress);
  mirrorLocalDB(STORAGE_KEY, state.progress);
}

function saveSettings() {
  const settings = {
    kind: state.currentKind,
    taskOnly: state.filters.task,
    newOnly: state.filters.new,
  };
  saveLocalJSON(SETTINGS_KEY, settings);
  mirrorLocalDB(SETTINGS_KEY, settings);
}

function progressKey(position) {
  if (!position) return "";

  const kind = decisionKind(position) || position.decisionKind || position.decisionType || "unknown";
  if (position.xgid) {
    return `xgid:${kind}:${position.xgid}`;
  }

  const source = position.sourceFile || "";
  const game = position.gameNumber ?? "";
  const move = position.moveNumber ?? "";
  if (source || game !== "" || move !== "") {
    return `event:${kind}:${source}:${game}:${move}`;
  }

  return position.id || "";
}

function normalizedRecord(raw) {
  return {
    correct: Math.max(0, Number(raw?.correct) || 0),
    wrong: Math.max(0, Number(raw?.wrong) || 0),
  };
}

function recordFor(position) {
  if (!position) return normalizedRecord(null);

  const key = progressKey(position);
  const stable = state.progress[key];
  const legacy = position.id ? state.progress[position.id] : null;

  if (!stable) return normalizedRecord(legacy);
  if (!legacy || key === position.id) return normalizedRecord(stable);

  return {
    correct: Math.max(
      Math.max(0, Number(stable.correct) || 0),
      Math.max(0, Number(legacy.correct) || 0),
    ),
    wrong: Math.max(
      Math.max(0, Number(stable.wrong) || 0),
      Math.max(0, Number(legacy.wrong) || 0),
    ),
  };
}

function migrateProgressKeys() {
  let changed = false;

  state.positions.forEach((position) => {
    const key = progressKey(position);
    if (!key || !position.id || key === position.id) return;

    const legacy = state.progress[position.id];
    if (!legacy) return;

    const current = state.progress[key];
    const merged = {
      correct: Math.max(
        Math.max(0, Number(current?.correct) || 0),
        Math.max(0, Number(legacy.correct) || 0),
      ),
      wrong: Math.max(
        Math.max(0, Number(current?.wrong) || 0),
        Math.max(0, Number(legacy.wrong) || 0),
      ),
    };

    state.progress[key] = merged;
    delete state.progress[position.id];
    changed = true;
  });

  if (changed) saveProgress();
  return changed;
}

function isChallenge(position) {
  const record = recordFor(position);
  return record.correct === 0 || record.correct < record.wrong;
}

function isNewPosition(position, now = Date.now()) {
  const uploadedAt = Date.parse(position?.sourceAddedAt || "");
  if (!Number.isFinite(uploadedAt)) return false;
  const age = now - uploadedAt;
  return age >= 0 && age <= NEW_POSITION_WINDOW_MS;
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
  if (state.filters.task) pool = pool.filter(isChallenge);
  if (state.filters.new) pool = pool.filter(isNewPosition);
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

const boardPreloadCache = new Map();

function trimBoardPreloadCache() {
  while (boardPreloadCache.size > BOARD_PRELOAD_CACHE_LIMIT) {
    const oldestKey = boardPreloadCache.keys().next().value;
    boardPreloadCache.delete(oldestKey);
  }
}

function preloadBoard(position) {
  if (!position) return;
  const url = absoluteBoardUrl(position);

  if (boardPreloadCache.has(url)) {
    const cached = boardPreloadCache.get(url);
    boardPreloadCache.delete(url);
    boardPreloadCache.set(url, cached);
    return;
  }

  const image = new Image();
  image.decoding = "async";
  image.src = url;
  boardPreloadCache.set(url, image);
  trimBoardPreloadCache();

  if (typeof image.decode === "function") {
    image.decode().catch(() => {});
  }
}

function resetBoardQueue({ clearCache = false } = {}) {
  state.boardQueue = [];
  if (clearCache) boardPreloadCache.clear();
}

function refillBoardQueue() {
  const pool = activePool();
  if (!pool.length) {
    state.boardQueue = [];
    return;
  }

  const activeIds = new Set(pool.map((position) => position.id));
  state.boardQueue = state.boardQueue.filter(
    (position) => position?.id && position.id !== state.current?.id && activeIds.has(position.id),
  );

  const queuedIds = new Set(state.boardQueue.map((position) => position.id));
  if (state.current?.id) queuedIds.add(state.current.id);

  while (state.boardQueue.length < BOARD_PRELOAD_COUNT && queuedIds.size < pool.length) {
    const choices = pool.filter((position) => !queuedIds.has(position.id));
    if (!choices.length) break;
    const position = choices[Math.floor(Math.random() * choices.length)];
    state.boardQueue.push(position);
    queuedIds.add(position.id);
    preloadBoard(position);
  }
}

function queuedNextPosition() {
  const pool = activePool();
  const activeIds = new Set(pool.map((position) => position.id));

  while (state.boardQueue.length) {
    const position = state.boardQueue.shift();
    if (position?.id && position.id !== state.current?.id && activeIds.has(position.id)) {
      return position;
    }
  }

  return randomPosition(pool, state.current?.id || null);
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
  const counted = new Set();

  state.positions.forEach((position) => {
    const key = progressKey(position);
    if (!key || counted.has(key)) return;
    counted.add(key);

    const record = recordFor(position);
    correct += record.correct;
    wrong += record.wrong;
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
  saveLocalJSON(DAILY_STORAGE_KEY, state.daily);
  mirrorLocalDB(DAILY_STORAGE_KEY, state.daily);
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
  const record = recordFor(state.current);
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
  elements.taskCount.textContent = String(currentKindPositions.filter(isChallenge).length);
  elements.newCount.textContent = String(currentKindPositions.filter(isNewPosition).length);
}

function sourceFileLabel(position) {
  const source = position?.sourceFile || "";
  if (!source) return "";

  const matchLength = Number(position.matchLength) || 0;
  const gameNumber = Number(position.gameNumber) || 0;
  const isPointMatch = matchLength > 0 && matchLength < 99999;

  return isPointMatch && gameNumber > 0
    ? `${source} Game${gameNumber}`
    : source;
}

function populateAnswerData() {
  if (!state.current) return;
  elements.actionAnalysis.innerHTML = actionAnalysisHTML(state.current);
  elements.summaryAnalysis.innerHTML = summaryAnalysisHTML(state.current);
  elements.sourceFile.textContent = sourceFileLabel(state.current);
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
  elements.board.fetchPriority = "high";
  elements.board.src = absoluteBoardUrl(state.current);
  elements.board.alt = `${KIND_LABELS[state.currentKind]} quiz position`;
  refillBoardQueue();
  updatePositionRecord();
  populateAnswerData();
  resetAnswerUI();
}

function recordResult(result) {
  if (!state.current || (result !== "correct" && result !== "wrong")) return false;

  const record = recordFor(state.current);
  if (result === "correct") record.correct += 1;
  else record.wrong += 1;
  state.progress[progressKey(state.current)] = record;
  if (state.current.id && state.current.id !== progressKey(state.current)) {
    delete state.progress[state.current.id];
  }
  saveProgress();

  ensureDailyRecord();
  if (result === "correct") state.daily.correct += 1;
  else state.daily.wrong += 1;
  saveDaily();
  return true;
}

function selectNext() {
  state.current = queuedNextPosition();
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
  resetBoardQueue();
  elements.tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.kind === kind));
  saveSettings();
  renderCurrent();
}

function syncFilterButtons() {
  elements.filterButtons.forEach((button) => {
    const active = Boolean(state.filters[button.dataset.filter]);
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function toggleFilter(filter) {
  if (!(filter in state.filters)) return;
  state.filters[filter] = !state.filters[filter];
  state.current = null;
  resetBoardQueue();
  syncFilterButtons();
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
  elements.filterButtons.forEach((button) => {
    button.addEventListener("click", () => toggleFilter(button.dataset.filter));
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
  migrateProgressKeys();
  if (state.dataVersion !== nextVersion) resetBoardQueue({ clearCache: true });
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
  state.progress = await loadProgress();

  const localDaily = loadJSON(DAILY_STORAGE_KEY, null);
  const backupDaily = await readLocalDB(DAILY_STORAGE_KEY);
  state.daily = localDaily || (
    backupDaily && typeof backupDaily === "object"
      ? backupDaily
      : { day: "", correct: 0, wrong: 0 }
  );
  saveDaily();
  ensureDailyRecord({ seedFromTotal: true });
  const localSettings = loadJSON(SETTINGS_KEY, null);
  const backupSettings = await readLocalDB(SETTINGS_KEY);
  const settings = localSettings || (
    backupSettings && typeof backupSettings === "object" ? backupSettings : {}
  );
  if (KIND_LABELS[settings.kind]) state.currentKind = settings.kind;
  state.filters.task = Boolean(settings.taskOnly ?? settings.challengeOnly);
  state.filters.new = Boolean(settings.newOnly);
  elements.tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.kind === state.currentKind));
  syncFilterButtons();
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
  window.addEventListener("pagehide", () => {
    saveProgress();
    saveDaily();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      saveProgress();
      saveDaily();
      return;
    }

    if (!document.hidden) {
      if (ensureDailyRecord()) updateToday();
      scheduleDailyReset();
      refreshPositionsSilently();
    }
  });
}

start();
