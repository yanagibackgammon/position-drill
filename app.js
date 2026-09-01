"use strict";

const POSITIONS_ROOT = new URL("./", window.location.href).href;
const DATA_URL = `${POSITIONS_ROOT}data/positions.json`;
const STORAGE_KEY = "yanagi-backgammon-quiz-progress-v1";
const SETTINGS_KEY = "yanagi-backgammon-quiz-settings-v1";
const FILTER_MODE_VERSION = 4;
const ROOT_FOLDER_FILTER = "__root__";
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
  take: "Take/Pass",
};

const MATCH_TYPE_LABELS = {
  all: "ALL",
  point: "Point Match",
  dmp: "DMP",
  unlimited: "Unlimited",
};

const KIND_ORDER = ["checker", "double", "take"];
const MATCH_TYPE_ORDER = ["all", "point", "unlimited", "dmp"];
const CUBE_MATCH_TYPE_ORDER = ["all", "point", "unlimited"];

const state = {
  positions: [],
  currentKind: "checker",
  matchType: "all",
  current: null,
  answered: false,
  pipRevealed: false,
  selectedCheckerCandidateIndex: null,
  selectedCubeCandidateIndex: null,
  progress: {},
  daily: { day: "", correct: 0, wrong: 0 },
  dailyResetTimer: null,
  dataVersion: "",
  boardQueue: [],
  filters: { task: false, new: false },
  folderFilter: "",
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
  pageTitle: document.getElementById("page-title"),
  folderModal: document.getElementById("folder-modal"),
  folderModalList: document.getElementById("folder-modal-list"),
  folderModalClose: document.getElementById("folder-modal-close"),
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
    sourceFolder: state.folderFilter,
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

  const source = position.sourcePath || position.sourceFile || "";
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

function normalizedSourceFolder(position) {
  const explicit = String(position?.sourceFolder || "").replace(/^\/+|\/+$/g, "");
  if (explicit) return explicit;

  const path = String(position?.sourcePath || "").replace(/^\/+|\/+$/g, "");
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

function folderFilterMatches(position, filter = state.folderFilter) {
  const selected = String(filter || "");
  const folder = normalizedSourceFolder(position);
  if (!selected) return true;
  if (selected === ROOT_FOLDER_FILTER) return folder === "";
  return folder === selected || folder.startsWith(`${selected}/`);
}

function availableFolderFilters() {
  const folders = new Set();
  let hasRoot = false;

  state.positions.forEach((position) => {
    const folder = normalizedSourceFolder(position);
    if (!folder) {
      hasRoot = true;
      return;
    }

    const parts = folder.split("/").filter(Boolean);
    for (let index = 1; index <= parts.length; index += 1) {
      folders.add(parts.slice(0, index).join("/"));
    }
  });

  return [
    ...(hasRoot ? [ROOT_FOLDER_FILTER] : []),
    ...Array.from(folders).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  ];
}

function filteredPositionsForKind(kind) {
  let pool = positionsForKind(kind);
  if (state.folderFilter) {
    pool = pool.filter((position) => folderFilterMatches(position));
  }
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

function absoluteAssetUrl(path) {
  const url = new URL(path || "", POSITIONS_ROOT);
  if (state.dataVersion) url.searchParams.set("v", state.dataVersion);
  return url.href;
}

function absoluteBoardUrl(position) {
  return absoluteAssetUrl(position.quizBoardImage || position.boardImage || "");
}

function absoluteCheckerMoveBoardUrl(candidate) {
  return candidate?.moveBoardImage ? absoluteAssetUrl(candidate.moveBoardImage) : "";
}

function absoluteCubeActionBoardUrl(candidate) {
  return candidate?.actionBoardImage ? absoluteAssetUrl(candidate.actionBoardImage) : "";
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

function pipCountsFromPoints(points) {
  const boardPoints = Array.isArray(points) ? points : [];
  let black = 0;
  let white = 0;
  for (let point = 1; point <= 24; point += 1) {
    const value = Number(boardPoints[point] || 0);
    if (value > 0) black += point * value;
    if (value < 0) white += (25 - point) * -value;
  }
  black += 25 * Math.max(Number(boardPoints[25] || 0), 0);
  white += 25 * Math.max(-Number(boardPoints[0] || 0), 0);
  return { black, white };
}

function pipCounts(position) {
  // Keep the drill owner as black/bottom.  For Take Action that means the
  // cube receiver/taker is black, even though the displayed state is still
  // immediately before the opponent's cube offer.
  const points = position.decisionKind === "take" && Array.isArray(position.quizPosition)
    ? position.quizPosition
    : (Array.isArray(position.position) ? position.position : []);
  return pipCountsFromPoints(points);
}

function checkerCandidatePipCounts(position, candidate) {
  const black = Number(candidate?.pipBlack);
  const white = Number(candidate?.pipWhite);
  if (Number.isFinite(black) && Number.isFinite(white)) {
    return { black, white };
  }
  return pipCounts(position);
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

function orderedCheckerCandidates(position) {
  return (Array.isArray(position?.candidates) ? position.candidates : [])
    .filter((candidate) => {
      const loss = Number(candidate?.equityLoss);
      return Number.isFinite(loss) && loss >= 0 && loss < 100;
    })
    .slice()
    .sort((a, b) => Number(a.rank || 0) - Number(b.rank || 0));
}

function cubeActionCandidates(position) {
  if (!position || position.decisionType !== "cube") return [];
  const source = position.decisionKind === "take" ? position.quizCandidates : position.candidates;
  return (Array.isArray(source) ? source : [])
    .filter((candidate) => candidate && candidate.action)
    .slice(0, position.decisionKind === "take" ? 2 : 3);
}

function bestCubeCandidateIndex(position) {
  const candidates = cubeActionCandidates(position);
  if (!candidates.length) return null;
  if (position.decisionKind === "take") return 0;

  const bestAction = String(position.bestAction || "").trim();
  const exact = candidates.findIndex(
    (candidate) => String(candidate.action || "").trim() === bestAction,
  );
  if (exact >= 0) return exact;

  // Too Good is the same no-offer continuation as the first cube candidate.
  return 0;
}

function candidateHasRates(candidate) {
  return checkerCandidateHasRates(candidate);
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
        <div class="action-option is-action-candidate is-cube-candidate ${best ? "is-best" : ""}" data-cube-candidate-index="${index}" role="button" tabindex="0">
          <span class="action-text ${isPlayed(candidate.action) ? "is-played" : ""}">${escapeHTML(candidate.action || "—")}</span>
          <span class="action-error ${best ? "best-marker" : tone}">${escapeHTML(best ? "BEST" : formatSignedEquity(candidate.equityDifference))}</span>
        </div>`;
      }).join("")}</div>`;
    }

    const outcomes = (Array.isArray(position.candidates) ? position.candidates : [])
      .filter((candidate) => candidate && candidate.action)
      .slice(0, 3);
    const bestAction = position.bestAction || "—";
    const bestIndex = bestCubeCandidateIndex(position);
    const bestWasPlayed = isPlayed(bestAction)
      || (bestIndex != null && isPlayed(outcomes[bestIndex]?.action));
    const rows = [
      `<div class="action-option is-best is-action-candidate is-cube-candidate"${bestIndex != null ? ` data-cube-candidate-index="${bestIndex}" role="button" tabindex="0"` : ""}><span class="action-text ${bestWasPlayed ? "is-played" : ""}">${escapeHTML(bestAction)}</span><span class="action-error best-marker">BEST</span></div>`,
      ...outcomes.flatMap((candidate, index) => {
        // The first row already represents the best Double action. Do not
        // repeat that same underlying candidate again in the rows below.
        if (index === bestIndex) return [];
        const tone = errorToneClass(candidate.equityDifference);
        return [`
        <div class="action-option is-action-candidate is-cube-candidate" data-cube-candidate-index="${index}" role="button" tabindex="0">
          <span class="action-text ${isPlayed(candidate.action) ? "is-played" : ""}">${escapeHTML(candidate.action || "—")}</span>
          <span class="action-error ${tone}">${escapeHTML(formatSignedEquity(candidate.equityDifference))}</span>
        </div>`];
      }),
    ];
    return `<div class="action-list">${rows.join("")}</div>`;
  }

  const ordered = orderedCheckerCandidates(position);

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
      <div class="action-option is-action-candidate is-checker-candidate ${best ? "is-best" : ""}" data-checker-candidate-index="${index}" role="button" tabindex="0">
        <span class="action-text ${isPlayed(candidate.action) ? "is-played" : ""}">${escapeHTML(candidate.action || "—")}</span>
        <span class="action-error ${best ? "best-marker" : tone}">${escapeHTML(best ? "BEST" : formatError(candidate.equityLoss))}</span>
      </div>`;
  }).join("")}</div>`;
}

function summaryAnalysisHTML(position, selectedCandidate = null) {
  const checkerCandidate = position.decisionKind === "checker" ? selectedCandidate : null;
  const pips = checkerCandidate
    ? checkerCandidatePipCounts(position, checkerCandidate)
    : pipCounts(position);
  const pipDisplay = pipDisplayValues(pips);
  const isTake = position.decisionKind === "take";
  const isCubeDecision = position.decisionKind === "double" || isTake;

  // Double and Take/Pass game information always represents the state before
  // the cube offer (No Double). Candidate selection only changes the answer
  // highlight; it must not change W/GW/BG or the displayed cube value.
  const noDoubleCandidate = isCubeDecision && Array.isArray(position.candidates)
    ? position.candidates.find((candidate) => {
        const action = String(candidate?.action || "").trim().toLowerCase();
        return action === "no double" || action === "no redouble";
      }) || position.candidates[0] || null
    : null;
  const noDoubleRates = noDoubleCandidate && candidateHasRates(noDoubleCandidate)
    ? (isTake
      ? {
          winRate: noDoubleCandidate.loseRate,
          loseRate: noDoubleCandidate.winRate,
          gammonWinRate: noDoubleCandidate.gammonLoseRate,
          gammonLoseRate: noDoubleCandidate.gammonWinRate,
          backgammonWinRate: noDoubleCandidate.backgammonLoseRate,
          backgammonLoseRate: noDoubleCandidate.backgammonWinRate,
        }
      : noDoubleCandidate)
    : null;

  // Black/bottom is always the drill owner. In Take Action the drill owner is
  // the receiver/taker, so retain the responder-perspective scores while using
  // the pre-offer (No Double) probability vector above.
  const rawPlayerScore = isTake && position.quizPlayerScore != null
    ? position.quizPlayerScore
    : position.playerScore;
  const rawOpponentScore = isTake && position.quizOpponentScore != null
    ? position.quizOpponentScore
    : position.opponentScore;
  const rawCubeValue = position.cubeValue;
  const checkerRateSource = checkerCandidate && checkerCandidateHasRates(checkerCandidate)
    ? checkerCandidate
    : position;
  // With no Checker move selected, show the position BEFORE the dice roll,
  // rather than the move that happened in the recorded match. New builds
  // publish explicit preRoll* fields for this state. The property check keeps
  // backward compatibility with older cached JSON that lacks those fields.
  const hasCheckerPreRollRates = position.decisionKind === "checker"
    && !checkerCandidate
    && Object.prototype.hasOwnProperty.call(position, "preRollWinRate");
  const checkerBaseRates = hasCheckerPreRollRates
    ? {
        winRate: position.preRollWinRate,
        loseRate: position.preRollLoseRate,
        gammonWinRate: position.preRollGammonWinRate,
        gammonLoseRate: position.preRollGammonLoseRate,
        backgammonWinRate: position.preRollBackgammonWinRate,
        backgammonLoseRate: position.preRollBackgammonLoseRate,
      }
    : checkerRateSource;
  const gameInfoRates = noDoubleRates || checkerBaseRates;
  const winRate = gameInfoRates.winRate;
  const loseRate = gameInfoRates.loseRate;
  const gammonWinRate = gameInfoRates.gammonWinRate;
  const gammonLoseRate = gameInfoRates.gammonLoseRate;
  const backgammonWinRate = gameInfoRates.backgammonWinRate;
  const backgammonLoseRate = gameInfoRates.backgammonLoseRate;

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
        ${statLine("PIP", `<span class="pip-placeholder">--</span><span class="pip-real">${escapeHTML(pipDisplay.black)}</span>`)}
        ${statLine("PIP", `<span class="pip-placeholder">--</span><span class="pip-real">${escapeHTML(pipDisplay.white)}</span>`)}

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
  // 1st menu: total positions for the selected decision kind, independent of
  // match type / Task / New filters.
  const kindTotal = positionsForKind(state.currentKind)
    .filter((position) => folderFilterMatches(position)).length;

  // 2nd menu: positions remaining after every active filter is applied.
  const filteredCount = filteredPositionsForKind(state.currentKind).length;

  if (elements.kindCount) elements.kindCount.textContent = String(kindTotal);
  if (elements.matchCount) elements.matchCount.textContent = String(filteredCount);
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

  const numericIndex = Number(index);
  const candidates = orderedCheckerCandidates(state.current);

  const candidate = candidates[numericIndex];
  if (!candidate) return;

  elements.actionAnalysis
    .querySelectorAll(".action-option.is-selected")
    .forEach((row) => row.classList.remove("is-selected"));

  if (state.selectedCheckerCandidateIndex === numericIndex) {
    state.selectedCheckerCandidateIndex = null;
    elements.summaryAnalysis.innerHTML = summaryAnalysisHTML(state.current);
    elements.summaryAnalysis.scrollTop = 0;
    resetSummaryTextScroll();
    elements.board.src = absoluteBoardUrl(state.current);
    elements.board.alt = `${KIND_LABELS.checker} quiz position`;
    return;
  }

  state.selectedCheckerCandidateIndex = numericIndex;
  const selected = elements.actionAnalysis.querySelector(
    `[data-checker-candidate-index="${numericIndex}"]`,
  );
  if (selected) selected.classList.add("is-selected");

  elements.summaryAnalysis.innerHTML = summaryAnalysisHTML(state.current, candidate);
  elements.summaryAnalysis.scrollTop = 0;
  resetSummaryTextScroll();

  const moveBoardUrl = absoluteCheckerMoveBoardUrl(candidate);
  if (moveBoardUrl) {
    elements.board.src = moveBoardUrl;
    elements.board.alt = `${candidate.action || "Checker move"} after position`;
  } else {
    elements.board.src = absoluteBoardUrl(state.current);
  }
}

function selectCubeCandidate(index) {
  if (!state.current || !state.answered || state.current.decisionType !== "cube") return;

  const numericIndex = Number(index);
  const candidates = cubeActionCandidates(state.current);
  const candidate = candidates[numericIndex];
  if (!candidate) return;

  elements.actionAnalysis
    .querySelectorAll(".action-option.is-selected")
    .forEach((row) => row.classList.remove("is-selected"));

  // Double and Take/Pass keep both the position diagram and game information
  // fixed at the state before the cube offer (No Double). Because candidate
  // selection no longer changes either display, keep the dark-gold answer band
  // fixed on the best action even if another action row is pressed.
  if (state.current.decisionKind === "double" || state.current.decisionKind === "take") {
    const bestIndex = bestCubeCandidateIndex(state.current);
    state.selectedCubeCandidateIndex = bestIndex;
    const selected = bestIndex == null ? null : elements.actionAnalysis.querySelector(
      `[data-cube-candidate-index="${bestIndex}"]`,
    );
    if (selected) selected.classList.add("is-selected");
    elements.summaryAnalysis.innerHTML = summaryAnalysisHTML(state.current);
    elements.summaryAnalysis.scrollTop = 0;
    resetSummaryTextScroll();
    elements.board.src = absoluteBoardUrl(state.current);
    elements.board.alt = `${KIND_LABELS[state.current.decisionKind] || "Cube Action"} quiz position`;
    return;
  }

  if (state.selectedCubeCandidateIndex === numericIndex) {
    state.selectedCubeCandidateIndex = null;
    elements.summaryAnalysis.innerHTML = summaryAnalysisHTML(state.current);
    elements.summaryAnalysis.scrollTop = 0;
    resetSummaryTextScroll();
    elements.board.src = absoluteBoardUrl(state.current);
    elements.board.alt = `${KIND_LABELS[state.current.decisionKind] || "Cube Action"} quiz position`;
    return;
  }

  state.selectedCubeCandidateIndex = numericIndex;
  const selected = elements.actionAnalysis.querySelector(
    `[data-cube-candidate-index="${numericIndex}"]`,
  );
  if (selected) selected.classList.add("is-selected");

  elements.summaryAnalysis.innerHTML = summaryAnalysisHTML(state.current, candidate);
  elements.summaryAnalysis.scrollTop = 0;
  resetSummaryTextScroll();

  const actionBoardUrl = absoluteCubeActionBoardUrl(candidate);
  if (actionBoardUrl) {
    elements.board.src = actionBoardUrl;
    elements.board.alt = `${candidate.action || "Cube action"} position`;
  } else {
    elements.board.src = absoluteBoardUrl(state.current);
  }
}

function handleCheckerCandidateInteraction(event) {
  if (!state.current || !state.answered || state.current.decisionKind !== "checker") return;

  const row = event.target.closest?.("[data-checker-candidate-index]");
  if (!row || !elements.actionAnalysis.contains(row)) return;

  if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
  if (event.type === "keydown") event.preventDefault();

  selectCheckerCandidate(row.dataset.checkerCandidateIndex);
}

function handleCubeCandidateInteraction(event) {
  if (!state.current || !state.answered || state.current.decisionType !== "cube") return;

  const row = event.target.closest?.("[data-cube-candidate-index]");
  if (!row || !elements.actionAnalysis.contains(row)) return;

  if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
  if (event.type === "keydown") event.preventDefault();

  selectCubeCandidate(row.dataset.cubeCandidateIndex);
}

function resetAnswerUI() {
  state.answered = false;
  state.pipRevealed = false;
  state.selectedCheckerCandidateIndex = null;
  state.selectedCubeCandidateIndex = null;
  elements.card.classList.remove("is-answered");
  elements.card.classList.remove("is-pip-revealed");
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
  state.pipRevealed = false;
  state.selectedCheckerCandidateIndex = null;
  state.selectedCubeCandidateIndex = null;

  // Keep every layout area mounted so filtering to zero positions does not
  // cause the page to jump or collapse.
  elements.card.hidden = false;
  elements.card.classList.remove("is-answered");
  elements.card.classList.remove("is-pip-revealed");
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

function togglePreAnswerPip() {
  if (!state.current || state.answered) return;
  state.pipRevealed = !state.pipRevealed;
  elements.card.classList.toggle("is-pip-revealed", state.pipRevealed);
}

function showAnswer() {
  if (!state.current) return;
  state.answered = true;
  state.pipRevealed = false;
  state.selectedCheckerCandidateIndex = null;
  state.selectedCubeCandidateIndex = null;
  elements.card.classList.remove("is-pip-revealed");
  elements.actionAnalysis.scrollTop = 0;
  elements.summaryAnalysis.scrollTop = 0;
  resetSummaryTextScroll();
  elements.card.classList.add("is-answered");
  elements.answerButton.hidden = true;
  elements.judgeButtons.hidden = false;

  if (state.current.decisionKind === "checker") {
    selectCheckerCandidate(0);
  } else if (state.current.decisionType === "cube") {
    const bestIndex = bestCubeCandidateIndex(state.current);
    if (bestIndex != null) selectCubeCandidate(bestIndex);
  }

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
          ? "Take/Pass"
          : "ALL",
  };
}

function matchTypeDisplayLabels(matchType) {
  return {
    full: MATCH_TYPE_LABELS[matchType] || "Point Match",
    short: matchType === "point" ? "Point Match" : (MATCH_TYPE_LABELS[matchType] || "Point"),
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

  // The first selector (Checker / Double / Take) never uses the gold active fill.
  elements.kindSelector?.classList.remove("is-active");
  elements.kindSelectorSlot?.classList.remove("is-disabled");
}

function matchTypeOrderForKind(kind = state.currentKind) {
  return kind === "checker" ? MATCH_TYPE_ORDER : CUBE_MATCH_TYPE_ORDER;
}

function normalizeMatchTypeForKind(kind, matchType) {
  return matchTypeOrderForKind(kind).includes(matchType) ? matchType : "all";
}

function setKind(kind) {
  if (!KIND_ORDER.includes(kind)) return;
  state.currentKind = kind;
  state.matchType = normalizeMatchTypeForKind(kind, state.matchType);
  state.current = null;
  resetBoardQueue();
  syncKindButtons();
  syncMatchTypeButtons();
  saveSettings();
  renderCurrent();
}

function syncMatchTypeButtons() {
  setSelectorLabels(elements.matchSelector, matchTypeDisplayLabels(state.matchType));
  if (elements.matchSelector) {
    // The second selector (ALL / Point Match / Unlimited / DMP) also stays visually neutral.
    elements.matchSelector.classList.remove("is-active");
    elements.matchSelector.setAttribute("aria-label", `Match type: ${MATCH_TYPE_LABELS[state.matchType]}`);
  }
}

function setMatchType(matchType) {
  if (!matchTypeOrderForKind().includes(matchType)) return;
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
  const order = matchTypeOrderForKind();
  setMatchType(cycleOptionValue(order, state.matchType, delta));
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
    if (label) label.textContent = activeLabel;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", `${activeLabel} filter: ${active ? "on" : "off"}`);
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

function folderFilterDisplayLabel(filter) {
  if (!filter) return "ALL";
  if (filter === ROOT_FOLDER_FILTER) return "imports直下";
  const parts = String(filter).split("/");
  return parts[parts.length - 1] || filter;
}

function folderFilterCount(filter) {
  return state.positions.filter((position) => folderFilterMatches(position, filter)).length;
}

function renderFolderModal() {
  if (!elements.folderModalList) return;

  const filters = ["", ...availableFolderFilters()];
  elements.folderModalList.innerHTML = filters.map((filter) => {
    const selected = filter === state.folderFilter;
    const depth = !filter || filter === ROOT_FOLDER_FILTER ? 0 : Math.max(0, filter.split("/").length - 1);
    const fullLabel = !filter ? "ALL" : (filter === ROOT_FOLDER_FILTER ? "imports直下" : filter);
    const label = folderFilterDisplayLabel(filter);
    return `
      <button type="button" class="folder-option ${selected ? "is-selected" : ""}"
        data-folder-filter="${escapeHTML(filter)}" role="option" aria-selected="${selected}"
        title="${escapeHTML(fullLabel)}" style="--folder-depth:${depth}">
        <span class="folder-option-mark" aria-hidden="true">${selected ? "✓" : ""}</span>
        <span class="folder-option-label">${escapeHTML(label)}</span>
        <span class="folder-option-count">${folderFilterCount(filter)}</span>
      </button>`;
  }).join("");
}

function openFolderModal() {
  if (!elements.folderModal) return;
  renderFolderModal();
  elements.folderModal.hidden = false;
  document.body.classList.add("folder-modal-open");
  window.setTimeout(() => {
    elements.folderModalList?.querySelector('[aria-selected="true"]')?.focus?.();
  }, 0);
}

function closeFolderModal() {
  if (!elements.folderModal || elements.folderModal.hidden) return;
  elements.folderModal.hidden = true;
  document.body.classList.remove("folder-modal-open");
  elements.pageTitle?.focus?.({ preventScroll: true });
}

function setFolderFilter(filter) {
  const next = String(filter || "");
  const valid = next === "" || availableFolderFilters().includes(next);
  if (!valid) return;
  state.folderFilter = next;
  state.current = null;
  resetBoardQueue();
  saveSettings();
  renderCurrent();
  closeFolderModal();
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
  elements.pageTitle?.addEventListener("click", openFolderModal);
  elements.pageTitle?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openFolderModal();
  });
  elements.folderModalClose?.addEventListener("click", closeFolderModal);
  elements.folderModal?.addEventListener("click", (event) => {
    if (event.target === elements.folderModal) closeFolderModal();
  });
  elements.folderModalList?.addEventListener("click", (event) => {
    const option = event.target.closest?.("[data-folder-filter]");
    if (!option) return;
    setFolderFilter(option.dataset.folderFilter || "");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements.folderModal && !elements.folderModal.hidden) {
      closeFolderModal();
    }
  });

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
  elements.summaryAnalysis.addEventListener("click", togglePreAnswerPip);
  elements.actionAnalysis.addEventListener("click", handleCheckerCandidateInteraction);
  elements.actionAnalysis.addEventListener("keydown", handleCheckerCandidateInteraction);
  elements.actionAnalysis.addEventListener("click", handleCubeCandidateInteraction);
  elements.actionAnalysis.addEventListener("keydown", handleCubeCandidateInteraction);
}

async function syncPositions({ initial = false } = {}) {
  const response = await fetch(`${DATA_URL}?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const payload = await response.json();
  const nextVersion = String(payload.meta?.generatedAt || payload.meta?.positionCount || Date.now());
  if (!initial && nextVersion === state.dataVersion) return false;

  const previousId = state.current?.id || null;
  state.positions = (payload.positions || []).filter((position) => decisionKind(position));
  if (state.folderFilter && !availableFolderFilters().includes(state.folderFilter)) {
    state.folderFilter = "";
    saveSettings();
  }
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
  state.matchType = normalizeMatchTypeForKind(state.currentKind, state.matchType);
  if (Number(settings.filterModeVersion) >= 2) {
    state.filters.task = Boolean(settings.taskOnly ?? settings.challengeOnly ?? false);
    state.filters.new = Boolean(settings.newOnly ?? false);
    state.folderFilter = typeof settings.sourceFolder === "string" ? settings.sourceFolder : "";
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
