const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appPath = path.join(__dirname, "..", "app.js");
const source = fs
  .readFileSync(appPath, "utf8")
  .replace(/\nstart\(\);\s*$/, "\n");

function dummyElement() {
  return {
    hidden: false,
    innerHTML: "",
    textContent: "",
    src: "",
    dataset: {},
    classList: {
      toggle() {},
      add() {},
      remove() {},
    },
    style: {
      setProperty() {},
    },
    addEventListener() {},
    removeAttribute() {},
    setAttribute() {},
  };
}

const context = {
  console,
  URL,
  Date,
  Math,
  JSON,
  Promise,
  Map,
  Set,
  Image: function Image() {},
  localStorage: {
    getItem() { return null; },
    setItem() {},
  },
  indexedDB: {
    open() { throw new Error("IndexedDB must not be used by pure-logic tests"); },
  },
  fetch: async () => {
    throw new Error("fetch must not be used by pure-logic tests");
  },
  document: {
    hidden: false,
    documentElement: { style: { setProperty() {} } },
    getElementById() { return dummyElement(); },
    querySelectorAll() { return []; },
    addEventListener() {},
  },
  window: {
    location: { href: "https://example.test/position-drill/" },
    matchMedia() { return { matches: false }; },
    addEventListener() {},
    setInterval() { return 0; },
    setTimeout() { return 0; },
    clearTimeout() {},
  },
};
context.window.window = context.window;

vm.createContext(context);
vm.runInContext(source, context, { filename: "app.js" });

function evaluate(expression) {
  return vm.runInContext(expression, context);
}

function run(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

run("Task: stays until correct strictly exceeds wrong", () => {
  evaluate("state.progress = {}");
  assert.equal(
    evaluate('isChallenge({id:"P1",decisionKind:"checker"})'),
    true,
  );

  evaluate('state.progress = {P1:{correct:1,wrong:1}}');
  assert.equal(
    evaluate('isChallenge({id:"P1",decisionKind:"checker"})'),
    true,
  );

  evaluate('state.progress = {P1:{correct:2,wrong:1}}');
  assert.equal(
    evaluate('isChallenge({id:"P1",decisionKind:"checker"})'),
    false,
  );

  evaluate('state.progress = {P1:{correct:1,wrong:2}}');
  assert.equal(
    evaluate('isChallenge({id:"P1",decisionKind:"checker"})'),
    true,
  );
});

run("New: build-time boolean wins, timestamp fallback is seven days", () => {
  assert.equal(evaluate("isNewPosition({isNew:true}, 0)"), true);
  assert.equal(evaluate("isNewPosition({isNew:false}, 0)"), false);

  const now = Date.parse("2026-08-24T00:00:00Z");
  context.testNow = now;
  context.within = {
    sourceUploadedAtMs: now - (7 * 24 * 60 * 60 * 1000),
  };
  context.outside = {
    sourceUploadedAtMs: now - (7 * 24 * 60 * 60 * 1000) - 1,
  };
  assert.equal(evaluate("isNewPosition(within, testNow)"), true);
  assert.equal(evaluate("isNewPosition(outside, testNow)"), false);
});

run("Task + New filters intersect and counts are per decision kind", () => {
  evaluate(`
    state.positions = [
      {id:"C1",decisionKind:"checker",isNew:true},
      {id:"C2",decisionKind:"checker",isNew:false},
      {id:"D1",decisionKind:"double",isNew:true},
      {id:"T1",decisionKind:"take",isNew:true}
    ];
    state.progress = {
      C1:{correct:0,wrong:0},
      C2:{correct:1,wrong:0},
      D1:{correct:2,wrong:0},
      T1:{correct:0,wrong:1}
    };
    state.filters = {task:true,new:true};
  `);

  assert.deepEqual(
    Array.from(evaluate('filteredPositionsForKind("checker").map(p => p.id)')),
    ["C1"],
  );
  assert.deepEqual(
    Array.from(evaluate('filteredPositionsForKind("double").map(p => p.id)')),
    [],
  );
  assert.deepEqual(
    Array.from(evaluate('filteredPositionsForKind("take").map(p => p.id)')),
    ["T1"],
  );
});

run("Take game info uses receiver perspective but PRE-OFFER cube", () => {
  context.takePosition = {
    decisionKind: "take",
    position: Array(26).fill(0),
    quizPosition: Array(26).fill(0),
    playerScore: 4,
    opponentScore: 4,
    quizPlayerScore: 4,
    quizOpponentScore: 4,
    cubeValue: 2,
    quizCubeValue: 4,
    matchLength: 7,
    isCrawford: false,
    isPostCrawford: false,
    winRate: 0.39,
    loseRate: 0.61,
    gammonWinRate: 0.10,
    gammonLoseRate: 0.20,
    backgammonWinRate: 0.01,
    backgammonLoseRate: 0.02,
    quizWinRate: 0.61,
    quizLoseRate: 0.39,
    quizGammonWinRate: 0.20,
    quizGammonLoseRate: 0.10,
    quizBackgammonWinRate: 0.03,
    quizBackgammonLoseRate: 0.01,
  };

  const html = evaluate("summaryAnalysisHTML(takePosition)");
  assert.match(
    html,
    /<span class="stat-label">CB<\/span><span class="stat-value ">2<\/span>/,
  );
  assert.match(html, />61\.0%<\/span>/);
});

run("DMP and Unlimited game-info conventions stay fixed", () => {
  context.basePosition = {
    decisionKind: "double",
    position: Array(26).fill(0),
    playerScore: 0,
    opponentScore: 0,
    cubeValue: 4,
    isCrawford: false,
    isPostCrawford: false,
    winRate: 0.5,
    loseRate: 0.5,
    gammonWinRate: 0,
    gammonLoseRate: 0,
    backgammonWinRate: 0,
    backgammonLoseRate: 0,
  };

  context.dmpPosition = { ...context.basePosition, matchLength: 1 };
  const dmp = evaluate("summaryAnalysisHTML(dmpPosition)");
  assert.match(dmp, />1<\/span>/);
  assert.match(dmp, />0 \(1a\)<\/span>/);

  context.unlimitedPosition = {
    ...context.basePosition,
    matchLength: 99999,
    cubeValue: 4,
  };
  const unlimited = evaluate("summaryAnalysisHTML(unlimitedPosition)");
  assert.match(
    unlimited,
    /<span class="stat-label">ML<\/span><span class="stat-value ">0<\/span>/,
  );
  assert.match(
    unlimited,
    /<span class="stat-label">CB<\/span><span class="stat-value ">4<\/span>/,
  );
});


run("Zero-result filter keeps the drill areas and game-info skeleton", () => {
  evaluate(`
    state.positions = [];
    state.current = null;
    state.filters = {task:true,new:true};
    renderCurrent();
  `);

  assert.equal(evaluate("elements.card.hidden"), false);
  assert.equal(evaluate("elements.empty.hidden"), true);
  assert.equal(evaluate("elements.sourceFile.hidden"), false);

  const summary = evaluate("elements.summaryAnalysis.innerHTML");
  assert.match(summary, />ML</);
  assert.match(summary, />CB</);
  assert.match(summary, />PIP</);
  assert.match(summary, />GW</);
  assert.match(summary, />BG</);
  assert.match(summary, /class="win-bar"/);
  assert.match(summary, /class="win-grid-line is-mid"/);
});


console.log("All app regression tests passed.");
