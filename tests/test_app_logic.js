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



run("Checker candidate selection switches only W/GW/BG rates and graph", () => {
  context.checkerPosition = {
    decisionKind: "checker",
    decisionType: "checker",
    position: Array(26).fill(0),
    playerScore: 2,
    opponentScore: 3,
    cubeValue: 1,
    matchLength: 7,
    isCrawford: false,
    isPostCrawford: false,
    winRate: 0.40,
    loseRate: 0.60,
    gammonWinRate: 0.10,
    gammonLoseRate: 0.20,
    backgammonWinRate: 0.01,
    backgammonLoseRate: 0.02,
    candidates: [
      {
        rank: 1,
        action: "13/8 6/5",
        equityLoss: 0,
        winRate: 0.62,
        loseRate: 0.38,
        gammonWinRate: 0.18,
        gammonLoseRate: 0.08,
        backgammonWinRate: 0.03,
        backgammonLoseRate: 0.01
      },
      {
        rank: 2,
        action: "13/7",
        equityLoss: 0.025,
        winRate: 0.55,
        loseRate: 0.45,
        gammonWinRate: 0.12,
        gammonLoseRate: 0.11,
        backgammonWinRate: 0.02,
        backgammonLoseRate: 0.01
      }
    ]
  };

  const actionHtml = evaluate("actionAnalysisHTML(checkerPosition)");
  assert.match(actionHtml, /data-checker-candidate-index="0"/);
  assert.match(actionHtml, /data-checker-candidate-index="1"/);

  context.selectedChecker = context.checkerPosition.candidates[1];
  const summary = evaluate("summaryAnalysisHTML(checkerPosition, selectedChecker)");
  assert.match(summary, />55\.0%<\/span>/);
  assert.match(summary, />45\.0%<\/span>/);
  assert.match(summary, />12\.0%<\/span>/);
  assert.match(summary, /left:55\.000%/);
});

run("Cube actions remain non-selectable", () => {
  context.cubePosition = {
    decisionKind: "double",
    decisionType: "cube",
    playedAction: "No Double",
    bestAction: "No Double",
    candidates: [
      {rank:1,action:"No Double",equityDifference:null},
      {rank:2,action:"Double/Take",equityDifference:-0.050}
    ]
  };

  const html = evaluate("actionAnalysisHTML(cubePosition)");
  assert.doesNotMatch(html, /data-checker-candidate-index/);
  assert.doesNotMatch(html, /is-checker-candidate/);
});



run("Match type classification separates Point Match, DMP, and Unlimited", () => {
  assert.equal(evaluate('positionMatchType({matchLength:7})'), "point");
  assert.equal(evaluate('positionMatchType({matchLength:1})'), "dmp");
  assert.equal(evaluate('positionMatchType({matchLength:0})'), "unlimited");
  assert.equal(evaluate('positionMatchType({matchLength:99999})'), "unlimited");
});

run("ALL decision kind and match type filter compose with Task/New", () => {
  evaluate(`
    state.positions = [
      {id:"C7",decisionKind:"checker",matchLength:7,isNew:true},
      {id:"D1",decisionKind:"double",matchLength:1,isNew:true},
      {id:"TU",decisionKind:"take",matchLength:99999,isNew:true},
      {id:"C7OLD",decisionKind:"checker",matchLength:7,isNew:false}
    ];
    state.progress = {
      C7:{correct:0,wrong:0},
      D1:{correct:0,wrong:0},
      TU:{correct:0,wrong:0},
      C7OLD:{correct:0,wrong:0}
    };
    state.matchType = "point";
    state.filters = {task:true,new:true};
  `);

  assert.deepEqual(
    Array.from(evaluate('filteredPositionsForKind("all").map(p => p.id)')),
    ["C7"],
  );
  assert.deepEqual(
    Array.from(evaluate('filteredPositionsForKind("checker").map(p => p.id)')),
    ["C7"],
  );

  evaluate('state.matchType = "all"; state.filters = {task:false,new:false};');
});

run("Menu page navigation wraps through four menu pages", () => {
  assert.equal(evaluate('normalizeMenuPageIndex(0)'), 0);
  assert.equal(evaluate('normalizeMenuPageIndex(3)'), 3);
  assert.equal(evaluate('normalizeMenuPageIndex(4)'), 0);
  assert.equal(evaluate('normalizeMenuPageIndex(-1)'), 3);
});


console.log("All app regression tests passed.");
