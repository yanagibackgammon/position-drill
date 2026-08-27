"use strict";

const POSITIONS_ROOT = new URL("./", window.location.href).href;
const DATA_URL = `${POSITIONS_ROOT}data/positions.json`;
const STORAGE_KEY = "yanagi-backgammon-quiz-progress-v1";
const SETTINGS_KEY = "yanagi-backgammon-quiz-settings-v1";
const FILTER_MODE_VERSION = 3;
const DAILY_STORAGE_KEY = "yanagi-backgammon-quiz-daily-v1";
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const BOARD_PRELOAD_COUNT = 3;
const BOARD_PRELOAD_CACHE_LIMIT = 8;
const LOCAL_DB_NAME = "position-drill-local-v1";
const LOCAL_DB_STORE = "records";
const NEW_POSITION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const KIND_LABELS = {
  all: "ALL",
  checker: "Checker Play",
  double: "Double Action",
  take: "Take Action",
};

const MATCH_TYPE_LABELS = {
  all: "ALL",
  point: "Point Match",
  dmp: "DMP",
  unlimited: "Unlimited",
};

const KIND_ORDER = ["checker", "double", "take", "all"];
const MATCH_TYPE_ORDER = ["point", "unlimited", "dmp", "all"];

const state = {
  positions: [],
  currentKind: "all",
  matchType: "all",
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
  kindSelector: document.getElementById("kind-selector"),
  kindSelectorSlot: document.getElementById("kind-selector-slot"),
  kindCount: document.getElementById("kind-count"),
  matchSelector: document.getElementById("match-selector"),
  matchSelectorSlot: document.getElementById("match-selector-slot"),
  matchCount: document.getElementById("match-count"),
  filterButtons: [...document.querySelectorAll("[data-filter]")],
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
    matchType: state.matchType,
    taskOnly: state.filters.task,
    newOnly: state.filters.new,
    filterModeVersion: FILTER_MODE_VERSION,
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
  return record.correct <= record.wrong;
}

function isNewPosition(position, now = Date.now()) {
  if (typeof position?.isNew === "boolean") {
    return position.isNew;
  }

  // Backward compatibility for data generated before build-time New flags.
  const numericUploadedAt = Number(position?.sourceUploadedAtMs);
  const uploadedAt = Number.isFinite(numericUploadedAt) && numericUploadedAt > 0
    ? numericUploadedAt
    : Date.parse(position?.sourceUploadedAt || position?.sourceAddedAt || "");

  if (!Number.isFinite(uploadedAt)) return false;

  const age = now - uploadedAt;
  return age >= -(5 * 60 * 1000) && age <= NEW_POSITION_WINDOW_MS;
}

function decisionKind(position) {
  if (position.decisionKind) return position.decisionKind;
  if (position.decisionType === "checker") return "checker";
  return null;
}

function positionMatchType(position) {
  const matchLength = Number(position?.matchLength);
  if (!Number.isFinite(matchLength) || matchLength <= 0 || matchLength >= 99999) {
    return "unlimited";
  }

  const playerScore = Number(position?.playerScore);
  const opponentScore = Number(position?.opponentScore);
  const rawCubeValue = Number(position?.cubeValue);
  const cubeValue = Number.isFinite(rawCubeValue) && rawCubeValue > 0
    ? rawCubeValue
    : 1;

  if (Number.isFinite(playerScore) && Number.isFinite(opponentScore)) {
    const playerAway = matchLength - playerScore;
    const opponentAway = matchLength - opponentScore;

    if (
      playerAway > 0 &&
      opponentAway > 0 &&
      playerAway <= cubeValue &&
      opponentAway <= cubeValue
    ) {
      return "dmp";
    }
  }

  // A one-point match is always DMP, including older data that may not
  // contain explicit score fields.
  if (matchLength === 1) return "dmp";

  return "point";
}

function positionsForKind(kind) {
  if (kind === "all") return state.positions.slice();
  return state.positions.filter((position) => decisionKind(position) === kind);
}

function positionsForMatchType(matchType) {
  if (matchType === "all") return state.positions.slice();
  return state.positions.filter((position) => positionMatchType(position) === matchType);
}

function filteredPositionsForKind(kind) {
  let pool = positionsForKind(kind);
  if (state.matchType !== "all") {
    pool = pool.filter((position) => positionMatchType(position) === state.matchType);
  }
  if (state.filters.task) pool = pool.filter(isChallenge);
  if (state.filters.new) pool = pool.filter(isNewPosition);
  return pool;
}

function activePool() {
  return filteredPositionsForKind(state.currentKind);
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
  // Keep the drill owner as black/bottom.  For Take Action that means the
  // cube receiver/taker is black, even though the displayed state is still
  // immediately before the opponent's cube offer.
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

function checkerCandidateHasRates(candidate) {
  if (!candidate) return false;
  return [
    "winRate",
    "loseRate",
    "gammonWinRate",
    "gammonLoseRate",
    "backgammonWinRate",
    "backgammonLoseRate",
  ].every((key) => candidate[key] != null && Number.isFinite(Number(candidate[key])));
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
    const inspectable = checkerCandidateHasRates(candidate);
    return `
      <div class="action-option ${best ? "is-best" : ""} ${inspectable ? "is-checker-candidate" : ""}"${inspectable ? ` data-checker-candidate-index="${index}" role="button" tabindex="0"` : ""}>
        <span class="action-text ${isPlayed(candidate.action) ? "is-played" : ""}">${escapeHTML(candidate.action || "—")}</span>
        <span class="action-error ${best ? "best-marker" : tone}">${escapeHTML(best ? "BEST" : formatError(candidate.equityLoss))}</span>
      </div>`;
  }).join("")}</div>`;
}

function summaryAnalysisHTML(position, checkerCandidate = null) {
  const pips = pipCounts(position);
  const pipDisplay = pipDisplayValues(pips);
  const isTake = position.decisionKind === "take";

  // Both cube modes show the PRE-OFFER state, but black/bottom is always the
  // drill owner.  In Take Action the drill owner is the receiver/taker, so use
  // the responder-perspective score and rates while keeping the PRE-OFFER cube.
  const rawPlayerScore = isTake && position.quizPlayerScore != null
    ? position.quizPlayerScore
    : position.playerScore;
  const rawOpponentScore = isTake && position.quizOpponentScore != null
    ? position.quizOpponentScore
    : position.opponentScore;
  const rawCubeValue = position.cubeValue;
  const checkerRateSource = position.decisionKind === "checker" && checkerCandidate
    ? checkerCandidate
    : position;
  const winRate = isTake && position.quizWinRate != null
    ? position.quizWinRate
    : checkerRateSource.winRate;
  const loseRate = isTake && position.quizLoseRate != null
    ? position.quizLoseRate
    : checkerRateSource.loseRate;
  const gammonWinRate = isTake && position.quizGammonWinRate != null
    ? position.quizGammonWinRate
    : checkerRateSource.gammonWinRate;
  const gammonLoseRate = isTake && position.quizGammonLoseRate != null
    ? position.quizGammonLoseRate
    : checkerRateSource.gammonLoseRate;
  const backgammonWinRate = isTake && position.quizBackgammonWinRate != null
    ? position.quizBackgammonWinRate
    : checkerRateSource.backgammonWinRate;
  const backgammonLoseRate = isTake && position.quizBackgammonLoseRate != null
    ? position.quizBackgammonLoseRate
    : checkerRateSource.backgammonLoseRate;

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

function emptySummaryAnalysisHTML() {
  // Preserve the complete game-information layout when the active filter has
  // no matching positions. Labels and the graph frame stay visible; only
  // position-specific values are blank.
  return `
    <div class="summary-text-scroll" aria-label="Game information">
      <div class="summary-text-grid">
        ${statLine("ML", "")}
        ${statLine("BK", "", "side-black")}
        ${statLine("WH", "", "side-white")}

        ${statLine("CB", "")}
        ${statLine("PIP", "")}
        ${statLine("PIP", "")}

        <div aria-hidden="true"></div>
        ${statLine("W", "")}
        ${statLine("W", "")}

        <div aria-hidden="true"></div>
        ${statLine("GW", "")}
        ${statLine("GW", "")}

        <div aria-hidden="true"></div>
        ${statLine("BG", "")}
        ${statLine("BG", "")}
      </div>
    </div>
    <div class="win-scale" aria-hidden="true">
      <span style="left:30%">30%</span>
      <span style="left:50%">50%</span>
      <span style="left:70%">70%</span>
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
  const matchTotal = positionsForMatchType(state.matchType).length;
  const filteredKindCount = filteredPositionsForKind(state.currentKind).length;
  if (elements.matchCount) elements.matchCount.textContent = String(matchTotal);
  if (elements.kindCount) elements.kindCount.textContent = String(filteredKindCount);
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

function selectCheckerCandidate(index) {
  if (!state.current || !state.answered || state.current.decisionKind !== "checker") return;

  const candidates = (Array.isArray(state.current.candidates) ? state.current.candidates : [])
    .filter((candidate) => {
      const loss = Number(candidate?.equityLoss);
      return Number.isFinite(loss) && loss >= 0 && loss < 100;
    })
    .slice()
    .sort((a, b) => Number(a.rank || 0) - Number(b.rank || 0));

  const candidate = candidates[Number(index)];
  if (!checkerCandidateHasRates(candidate)) return;

  elements.actionAnalysis
    .querySelectorAll(".action-option.is-selected")
    .forEach((row) => row.classList.remove("is-selected"));

  const selected = elements.actionAnalysis.querySelector(
    `[data-checker-candidate-index="${Number(index)}"]`,
  );
  if (selected) selected.classList.add("is-selected");

  elements.summaryAnalysis.innerHTML = summaryAnalysisHTML(state.current, candidate);
  elements.summaryAnalysis.scrollTop = 0;
  resetSummaryTextScroll();
}

function handleCheckerCandidateInteraction(event) {
  if (!state.current || !state.answered || state.current.decisionKind !== "checker") return;

  const row = event.target.closest?.("[data-checker-candidate-index]");
  if (!row || !elements.actionAnalysis.contains(row)) return;

  if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
  if (event.type === "keydown") event.preventDefault();

  selectCheckerCandidate(row.dataset.checkerCandidateIndex);
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

function renderEmptyDrillState() {
  state.current = null;
  state.answered = false;

  // Keep every layout area mounted so filtering to zero positions does not
  // cause the page to jump or collapse.
  elements.card.hidden = false;
  elements.card.classList.remove("is-answered");
  elements.card.classList.add("is-empty");
  elements.empty.hidden = true;

  elements.board.alt = "No matching positions";
  elements.actionAnalysis.innerHTML = '<div class="action-list" aria-hidden="true"></div>';
  elements.summaryAnalysis.innerHTML = emptySummaryAnalysisHTML();

  elements.answerPanel.hidden = false;
  elements.answerButton.hidden = false;
  elements.judgeButtons.hidden = true;
  elements.nextButton.hidden = false;

  elements.positionCorrect.textContent = "0";
  elements.positionWrong.textContent = "0";
  elements.sourceFile.textContent = "";
  elements.sourceFile.hidden = false;

  elements.actionAnalysis.scrollTop = 0;
  elements.summaryAnalysis.scrollTop = 0;
}


function renderCurrent() {
  const pool = activePool();
  updateCounts();
  updateTotals();

  if (!state.current || !pool.some((position) => position.id === state.current.id)) {
    state.current = randomPosition(pool, state.current?.id || null);
  }

  if (!state.current) {
    renderEmptyDrillState();
    return;
  }

  elements.card.hidden = false;
  elements.card.classList.remove("is-empty");
  elements.sourceFile.hidden = false;
  elements.empty.hidden = true;
  elements.board.fetchPriority = "high";
  elements.board.src = absoluteBoardUrl(state.current);
  const currentKindLabel = KIND_LABELS[decisionKind(state.current)] || KIND_LABELS[state.currentKind] || "Position";
  elements.board.alt = `${currentKindLabel} quiz position`;
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

function kindDisplayLabels(kind) {
  return {
    full: KIND_LABELS[kind] || "Checker Play",
    short: kind === "checker"
      ? "Checker"
      : kind === "double"
        ? "Double"
        : kind === "take"
          ? "Take"
          : "ALL",
  };
}

function matchTypeDisplayLabels(matchType) {
  return {
    full: MATCH_TYPE_LABELS[matchType] || "Point Match",
    short: matchType === "point" ? "Point" : (MATCH_TYPE_LABELS[matchType] || "Point"),
  };
}

function setSelectorLabels(button, labels) {
  if (!button) return;
  const full = button.querySelector(".selector-label-full");
  const short = button.querySelector(".selector-label-short");
  if (full) full.textContent = labels.full;
  if (short) short.textContent = labels.short;
}

function syncKindButtons() {
  setSelectorLabels(elements.kindSelector, kindDisplayLabels(state.currentKind));

  if (elements.kindSelector) {
    elements.kindSelector.disabled = false;
    elements.kindSelector.setAttribute(
      "aria-label",
      `Position type: ${KIND_LABELS[state.currentKind]}`,
    );
  }

  elements.kindSelector?.classList.toggle("is-active", state.currentKind !== "all");
  elements.kindSelectorSlot?.classList.remove("is-disabled");
}

function setKind(kind) {
  if (!KIND_ORDER.includes(kind)) return;
  state.currentKind = kind;
  state.current = null;
  resetBoardQueue();
  syncKindButtons();
  saveSettings();
  renderCurrent();
}

function syncMatchTypeButtons() {
  setSelectorLabels(elements.matchSelector, matchTypeDisplayLabels(state.matchType));
  if (elements.matchSelector) {
    elements.matchSelector.classList.toggle("is-active", state.matchType !== "all");
    elements.matchSelector.setAttribute("aria-label", `Match type: ${MATCH_TYPE_LABELS[state.matchType]}`);
  }
}

function setMatchType(matchType) {
  if (!MATCH_TYPE_ORDER.includes(matchType)) return;
  state.matchType = matchType;

  state.current = null;
  resetBoardQueue();
  syncMatchTypeButtons();
  syncKindButtons();
  saveSettings();
  renderCurrent();
}

function cycleOptionValue(order, current, delta) {
  const currentIndex = Math.max(0, order.indexOf(current));
  const nextIndex = (currentIndex + Number(delta) + order.length) % order.length;
  return order[nextIndex];
}

function cycleKind(delta) {
  setKind(cycleOptionValue(KIND_ORDER, state.currentKind, delta));
}

function cycleMatchType(delta) {
  setMatchType(cycleOptionValue(MATCH_TYPE_ORDER, state.matchType, delta));
}

function cycleSelector(selector, delta) {
  if (selector === "kind") cycleKind(delta);
  if (selector === "match") cycleMatchType(delta);
}

function syncFilterButtons() {
  elements.filterButtons.forEach((button) => {
    const filter = button.dataset.filter;
    const active = Boolean(state.filters[filter]);
    const activeLabel = filter === "task" ? "Task" : "New";
    const label = button.querySelector(".filter-label");
    if (label) label.textContent = active ? activeLabel : "ALL";
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", `${activeLabel} filter: ${active ? activeLabel : "ALL"}`);
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
  const smartphone = window.matchMedia("(max-width: 790px)");
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
  elements.kindSelector.addEventListener("click", () => cycleKind(1));
  elements.matchSelector.addEventListener("click", () => cycleMatchType(1));

  elements.filterButtons.forEach((button) => {
    button.addEventListener("click", () => toggleFilter(button.dataset.filter));
  });

  const installSelectorSwipe = (slot, selector) => {
    let startPoint = null;

    slot.addEventListener("touchstart", (event) => {
      if (!window.matchMedia("(max-width: 790px)").matches || event.touches.length !== 1) return;
      const touch = event.touches[0];
      startPoint = { x: touch.clientX, y: touch.clientY };
    }, { passive: true });

    slot.addEventListener("touchend", (event) => {
      if (!startPoint || !window.matchMedia("(max-width: 790px)").matches) {
        startPoint = null;
        return;
      }

      const touch = event.changedTouches?.[0];
      if (!touch) {
        startPoint = null;
        return;
      }

      const dx = touch.clientX - startPoint.x;
      const dy = touch.clientY - startPoint.y;
      startPoint = null;

      if (Math.abs(dy) < 28 || Math.abs(dy) <= Math.abs(dx)) return;
      cycleSelector(selector, dy < 0 ? 1 : -1);
    }, { passive: true });
  };

  installSelectorSwipe(elements.kindSelectorSlot, "kind");
  installSelectorSwipe(elements.matchSelectorSlot, "match");

  elements.answerButton.addEventListener("click", showAnswer);
  elements.correctButton.addEventListener("click", () => judge("correct"));
  elements.wrongButton.addEventListener("click", () => judge("wrong"));
  elements.nextButton.addEventListener("click", selectNext);
  elements.actionAnalysis.addEventListener("click", handleCheckerCandidateInteraction);
  elements.actionAnalysis.addEventListener("keydown", handleCheckerCandidateInteraction);
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
  if (KIND_ORDER.includes(settings.kind)) state.currentKind = settings.kind;
  if (MATCH_TYPE_ORDER.includes(settings.matchType)) state.matchType = settings.matchType;
  if (Number(settings.filterModeVersion) >= 2) {
    state.filters.task = Boolean(settings.taskOnly ?? settings.challengeOnly ?? false);
    state.filters.new = Boolean(settings.newOnly ?? false);
  } else {
    state.filters.task = false;
    state.filters.new = false;
  }
  syncKindButtons();
  syncMatchTypeButtons();
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
