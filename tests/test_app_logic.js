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
    querySelector() { return dummyElement(); },
    querySelectorAll() { return []; },
    contains() { return true; },
    scrollIntoView() {},
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
      {id:"C1",decisionKind:"checker",matchLength:7,isNew:true},
      {id:"C2",decisionKind:"checker",matchLength:7,isNew:false},
      {id:"D1",decisionKind:"double",matchLength:7,isNew:true},
      {id:"T1",decisionKind:"take",matchLength:7,isNew:true}
    ];
    state.progress = {
      C1:{correct:0,wrong:0},
      C2:{correct:1,wrong:0},
      D1:{correct:2,wrong:0},
      T1:{correct:0,wrong:1}
    };
    state.matchType = "point";
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


run("Folder filter includes descendants and can isolate imports root", () => {
  evaluate(`
    state.positions = [
      {id:"R",decisionKind:"checker",sourceFolder:"",sourcePath:"root.xgp",matchLength:7,isNew:true},
      {id:"A",decisionKind:"checker",sourceFolder:"MATCH",sourcePath:"MATCH/a.xgp",matchLength:7,isNew:true},
      {id:"B",decisionKind:"checker",sourceFolder:"MATCH/2026",sourcePath:"MATCH/2026/b.xgp",matchLength:7,isNew:true},
      {id:"C",decisionKind:"checker",sourceFolder:"CUBE",sourcePath:"CUBE/c.xgp",matchLength:7,isNew:true}
    ];
    state.progress = {};
    state.matchType = "all";
    state.filters = {task:false,new:false};
    state.folderFilter = "MATCH";
  `);
  assert.deepEqual(
    Array.from(evaluate('filteredPositionsForKind("checker").map(p => p.id)')),
    ["A", "B"],
  );
  evaluate('state.folderFilter = ROOT_FOLDER_FILTER');
  assert.deepEqual(
    Array.from(evaluate('filteredPositionsForKind("checker").map(p => p.id)')),
    ["R"],
  );
  assert.deepEqual(
    Array.from(evaluate('availableFolderFilters()')),
    ["__root__", "CUBE", "MATCH", "MATCH/2026"],
  );
});

run("Take/Pass game info always uses pre-offer No Double state", () => {
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
    decisionType: "cube",
    candidates: [
      {
        rank: 1,
        action: "No Double",
        cubeValue: 2,
        winRate: 0.45,
        loseRate: 0.55,
        gammonWinRate: 0.11,
        gammonLoseRate: 0.18,
        backgammonWinRate: 0.01,
        backgammonLoseRate: 0.02,
      },
      {
        rank: 2,
        action: "Double/Take",
        cubeValue: 4,
        winRate: 0.39,
        loseRate: 0.61,
        gammonWinRate: 0.10,
        gammonLoseRate: 0.20,
        backgammonWinRate: 0.01,
        backgammonLoseRate: 0.03,
      },
    ],
  };

  const html = evaluate("summaryAnalysisHTML(takePosition)");
  assert.match(
    html,
    /<span class="stat-label">CB<\/span><span class="stat-value ">2<\/span>/,
  );
  assert.match(html, />55\.0%<\/span>/);
});


run("Cube game info stays No Double and source marker is hidden", () => {
  context.sourceDoublePosition = {
    decisionKind: "double",
    decisionType: "cube",
    position: Array(26).fill(0),
    playerScore: 1,
    opponentScore: 2,
    cubeValue: 1,
    matchLength: 7,
    isCrawford: false,
    isPostCrawford: false,
    winRate: 0.50,
    loseRate: 0.50,
    gammonWinRate: 0.10,
    gammonLoseRate: 0.10,
    backgammonWinRate: 0.01,
    backgammonLoseRate: 0.01,
    candidates: [
      {
        action: "No Double",
        cubeValue: 1,
        winRate: 0.52,
        loseRate: 0.48,
        gammonWinRate: 0.11,
        gammonLoseRate: 0.09,
        backgammonWinRate: 0.01,
        backgammonLoseRate: 0.01,
      },
      {
        action: "Double/Take",
        cubeValue: 2,
        winRate: 0.61,
        loseRate: 0.39,
        gammonWinRate: 0.17,
        gammonLoseRate: 0.07,
        backgammonWinRate: 0.02,
        backgammonLoseRate: 0.01,
      },
    ],
  };
  context.sourceDtCandidate = {
    action: "Double/Take",
    cubeValue: 2,
    winRate: 0.61,
    loseRate: 0.39,
    gammonWinRate: 0.17,
    gammonLoseRate: 0.07,
    backgammonWinRate: 0.02,
    backgammonLoseRate: 0.01,
  };

  const ndHtml = evaluate("summaryAnalysisHTML(sourceDoublePosition)");
  assert.match(ndHtml, />52\.0%<\/span>/);
  assert.doesNotMatch(ndHtml, /<span class="stat-label">(?:ND|D\/T)<\/span>/);

  const dtHtml = evaluate("summaryAnalysisHTML(sourceDoublePosition, sourceDtCandidate)");
  assert.match(dtHtml, />52\.0%<\/span>/);
  assert.doesNotMatch(dtHtml, />61\.0%<\/span>/);
  assert.doesNotMatch(dtHtml, /<span class="stat-label">(?:ND|D\/T)<\/span>/);

  const takeHtml = evaluate("summaryAnalysisHTML(takePosition)");
  assert.match(takeHtml, />55\.0%<\/span>/);
  assert.doesNotMatch(takeHtml, /<span class="stat-label">(?:ND|D\/T)<\/span>/);
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

run("Double actions expose selectable rows and do not repeat the best action", () => {
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
  assert.match(html, /data-cube-candidate-index=/);
  assert.match(html, /is-cube-candidate/);
  assert.doesNotMatch(html, /data-checker-candidate-index/);
  assert.equal((html.match(/>No Double<\/span>/g) || []).length, 1);
  assert.equal((html.match(/>Double\/Take<\/span>/g) || []).length, 1);
});



run("Match type classification uses score and current cube for DMP", () => {
  assert.equal(
    evaluate('positionMatchType({matchLength:11,playerScore:9,opponentScore:9,cubeValue:2})'),
    "dmp",
  );
  assert.equal(
    evaluate('positionMatchType({matchLength:11,playerScore:7,opponentScore:7,cubeValue:4})'),
    "dmp",
  );
  assert.equal(
    evaluate('positionMatchType({matchLength:11,playerScore:10,opponentScore:10,cubeValue:1})'),
    "dmp",
  );
  assert.equal(
    evaluate('positionMatchType({matchLength:11,playerScore:9,opponentScore:8,cubeValue:2})'),
    "point",
  );
  assert.equal(
    evaluate('positionMatchType({matchLength:11,playerScore:9,opponentScore:9,cubeValue:1})'),
    "point",
  );
  assert.equal(
    evaluate('positionMatchType({matchLength:7,playerScore:4,opponentScore:4,cubeValue:2})'),
    "point",
  );
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

run("Kind selector cycles Checker / Double / Take only", () => {
  assert.deepEqual(Array.from(evaluate("KIND_ORDER")), ["checker", "double", "take"]);
  assert.equal(evaluate('cycleOptionValue(KIND_ORDER, "checker", 1)'), "double");
  assert.equal(evaluate('cycleOptionValue(KIND_ORDER, "double", 1)'), "take");
  assert.equal(evaluate('cycleOptionValue(KIND_ORDER, "take", 1)'), "checker");
  assert.equal(evaluate('cycleOptionValue(KIND_ORDER, "checker", -1)'), "take");
});

run("Checker match selector includes DMP, Double/Take selector skips it", () => {
  assert.deepEqual(
    Array.from(evaluate('matchTypeOrderForKind("checker")')),
    ["all", "point", "dmp", "unlimited"],
  );
  assert.deepEqual(
    Array.from(evaluate('matchTypeOrderForKind("double")')),
    ["all", "point", "unlimited"],
  );
  assert.deepEqual(
    Array.from(evaluate('matchTypeOrderForKind("take")')),
    ["all", "point", "unlimited"],
  );
  assert.equal(evaluate('cycleOptionValue(matchTypeOrderForKind("checker"), "point", 1)'), "dmp");
  assert.equal(evaluate('cycleOptionValue(matchTypeOrderForKind("checker"), "dmp", 1)'), "unlimited");
  assert.equal(evaluate('cycleOptionValue(matchTypeOrderForKind("double"), "unlimited", 1)'), "all");
  assert.equal(evaluate('cycleOptionValue(matchTypeOrderForKind("take"), "all", -1)'), "unlimited");
  assert.equal(evaluate('matchTypeDisplayLabels("point").short'), "Point Match");
  assert.equal(evaluate('matchTypeDisplayLabels("all").full'), "ALL");
  assert.equal(evaluate('kindDisplayLabels("checker").full'), "Checker");
  assert.equal(evaluate('kindDisplayLabels("double").full'), "Double");
  assert.equal(evaluate('kindDisplayLabels("take").full'), "Take/Pass");
});



run("Positions count follows every active condition", () => {
  evaluate(`
    state.positions = [
      {id:"C7",decisionKind:"checker",matchLength:7,isNew:true},
      {id:"C7OLD",decisionKind:"checker",matchLength:7,isNew:false},
      {id:"D7",decisionKind:"double",matchLength:7,isNew:true},
      {id:"C1",decisionKind:"checker",matchLength:1,isNew:true},
      {id:"DU",decisionKind:"double",matchLength:99999,isNew:true}
    ];
    state.progress = {};
    state.currentKind = "checker";
    state.matchType = "point";
    state.filters = {task:false,new:true};
    updateCounts();
  `);

  assert.equal(evaluate("elements.positionCount.textContent"), "1");
});


run("Checker + DMP switches match type to ALL when changing to Double/Take", () => {
  evaluate(`
    state.positions = [
      {id:"DMP-C",decisionKind:"checker",matchLength:1},
      {id:"PM-D",decisionKind:"double",matchLength:7,playerScore:0,opponentScore:0}
    ];
    state.currentKind = "checker";
    state.matchType = "dmp";
    setKind("double");
  `);

  assert.equal(evaluate("state.currentKind"), "double");
  assert.equal(evaluate("state.matchType"), "all");
  assert.equal(evaluate("elements.kindSelector.disabled"), false);

  evaluate('state.currentKind = "checker"; state.matchType = "dmp"; setKind("take");');
  assert.equal(evaluate("state.currentKind"), "take");
  assert.equal(evaluate("state.matchType"), "all");
});

run("Double/Take reject DMP but keep normal match selections", () => {
  evaluate('state.currentKind = "double"; state.matchType = "all";');
  evaluate('setMatchType("dmp")');
  assert.equal(evaluate("state.matchType"), "all");
  evaluate('setMatchType("point")');
  assert.equal(evaluate("state.matchType"), "point");
  evaluate('setMatchType("unlimited")');
  assert.equal(evaluate("state.matchType"), "unlimited");
  evaluate('cycleMatchType(1)');
  assert.equal(evaluate("state.matchType"), "all");
});


run("Cube-aware DMP positions sort into DMP instead of Point Match", () => {
  evaluate(`
    state.positions = [
      {
        id:"DMP-99-11-C2",
        decisionKind:"checker",
        matchLength:11,
        playerScore:9,
        opponentScore:9,
        cubeValue:2,
        isNew:true
      },
      {
        id:"POINT-99-11-C1",
        decisionKind:"checker",
        matchLength:11,
        playerScore:9,
        opponentScore:9,
        cubeValue:1,
        isNew:true
      }
    ];
    state.progress = {};
    state.currentKind = "checker";
    state.filters = {task:false,new:false};
  `);

  evaluate('state.matchType = "dmp"');
  assert.deepEqual(
    Array.from(evaluate('filteredPositionsForKind("checker").map(p => p.id)')),
    ["DMP-99-11-C2"],
  );

  evaluate('state.matchType = "point"');
  assert.deepEqual(
    Array.from(evaluate('filteredPositionsForKind("checker").map(p => p.id)')),
    ["POINT-99-11-C1"],
  );
});


run("Pre-answer PIP starts hidden as -- and toggles without answering", () => {
  context.pipPosition = {
    id: "PIP1",
    decisionKind: "checker",
    position: Array(26).fill(0),
    matchLength: 7,
    playerScore: 0,
    opponentScore: 0,
    cubeValue: 1,
    isCrawford: false,
    isPostCrawford: false,
    winRate: 0.5,
    loseRate: 0.5,
    gammonWinRate: 0,
    gammonLoseRate: 0,
    backgammonWinRate: 0,
    backgammonLoseRate: 0,
  };
  context.pipPosition.position[1] = 15;
  context.pipPosition.position[24] = -15;

  const html = evaluate("summaryAnalysisHTML(pipPosition)");
  assert.match(html, /class="pip-placeholder">--<\/span>/);
  assert.match(html, /class="pip-real">15<\/span>/);

  evaluate("state.current = pipPosition; state.answered = false; state.pipRevealed = false");
  evaluate("togglePreAnswerPip()");
  assert.equal(evaluate("state.pipRevealed"), true);
  assert.equal(evaluate("state.answered"), false);
  evaluate("togglePreAnswerPip()");
  assert.equal(evaluate("state.pipRevealed"), false);
});

run("Checker candidate can be selected and deselected by pressing the same move", () => {
  context.checkerTogglePosition = {
    id: "CHK1",
    decisionKind: "checker",
    decisionType: "move",
    position: Array(26).fill(0),
    matchLength: 7,
    playerScore: 0,
    opponentScore: 0,
    cubeValue: 1,
    isCrawford: false,
    isPostCrawford: false,
    winRate: 0.50,
    loseRate: 0.50,
    gammonWinRate: 0.10,
    gammonLoseRate: 0.10,
    backgammonWinRate: 0.01,
    backgammonLoseRate: 0.01,
    preRollWinRate: 0.44,
    preRollLoseRate: 0.56,
    preRollGammonWinRate: 0.08,
    preRollGammonLoseRate: 0.12,
    preRollBackgammonWinRate: 0.01,
    preRollBackgammonLoseRate: 0.02,
    quizBoardImage: "assets/boards-quiz/CHK1.svg",
    candidates: [{
      rank: 1,
      action: "13/8 6/5",
      moveBoardImage: "assets/boards-moves/CHK1-1.svg",
      equityLoss: 0,
      pipBlack: 40,
      pipWhite: 40,
      winRate: 0.60,
      loseRate: 0.40,
      gammonWinRate: 0.12,
      gammonLoseRate: 0.08,
      backgammonWinRate: 0.02,
      backgammonLoseRate: 0.01,
    }],
  };
  evaluate("state.current = checkerTogglePosition; state.answered = true; state.selectedCheckerCandidateIndex = null");
  evaluate("selectCheckerCandidate(0)");
  assert.equal(evaluate("state.selectedCheckerCandidateIndex"), 0);
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), />60\.0%<\/span>/);
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), /class="pip-real">40<\/span>/);
  assert.equal(
    evaluate("elements.board.src"),
    "https://example.test/position-drill/assets/boards-moves/CHK1-1.svg",
  );

  evaluate("selectCheckerCandidate(0)");
  assert.equal(evaluate("state.selectedCheckerCandidateIndex"), null);
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), />44\.0%<\/span>/);
  assert.doesNotMatch(evaluate("elements.summaryAnalysis.innerHTML"), />50\.0%<\/span>/);
  assert.equal(
    evaluate("elements.board.src"),
    "https://example.test/position-drill/assets/boards-quiz/CHK1.svg",
  );
});

run("CHECK auto-selects the best Checker move and deselect restores pre-roll state", () => {
  context.autoCheckerPosition = {
    id: "AUTO-C",
    decisionKind: "checker",
    decisionType: "checker",
    position: Array(26).fill(0),
    matchLength: 7,
    playerScore: 0,
    opponentScore: 0,
    cubeValue: 1,
    isCrawford: false,
    isPostCrawford: false,
    winRate: 0.50,
    loseRate: 0.50,
    gammonWinRate: 0.10,
    gammonLoseRate: 0.10,
    backgammonWinRate: 0.01,
    backgammonLoseRate: 0.01,
    preRollWinRate: 0.47,
    preRollLoseRate: 0.53,
    preRollGammonWinRate: 0.09,
    preRollGammonLoseRate: 0.11,
    preRollBackgammonWinRate: 0.01,
    preRollBackgammonLoseRate: 0.02,
    quizBoardImage: "assets/boards-quiz/AUTO-C.svg",
    candidates: [{
      rank: 1,
      action: "13/8 6/5",
      moveBoardImage: "assets/boards-moves/AUTO-C-1.svg",
      equityLoss: 0,
      pipBlack: 38,
      pipWhite: 41,
      winRate: 0.63,
      loseRate: 0.37,
      gammonWinRate: 0.15,
      gammonLoseRate: 0.07,
      backgammonWinRate: 0.02,
      backgammonLoseRate: 0.01,
    }],
  };

  evaluate("state.current = autoCheckerPosition; state.answered = false; state.selectedCheckerCandidateIndex = null");
  evaluate("showAnswer()");
  assert.equal(evaluate("state.selectedCheckerCandidateIndex"), 0);
  assert.equal(
    evaluate("elements.board.src"),
    "https://example.test/position-drill/assets/boards-moves/AUTO-C-1.svg",
  );
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), />63\.0%<\/span>/);
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), /class="pip-real">38(?: [^<]+)?<\/span>/);

  evaluate("selectCheckerCandidate(0)");
  assert.equal(evaluate("state.selectedCheckerCandidateIndex"), null);
  assert.equal(
    evaluate("elements.board.src"),
    "https://example.test/position-drill/assets/boards-quiz/AUTO-C.svg",
  );
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), />47\.0%<\/span>/);
  assert.doesNotMatch(evaluate("elements.summaryAnalysis.innerHTML"), />50\.0%<\/span>/);
});


run("Checker pre-roll rates stay blank when XG has no exact pre-roll evaluation", () => {
  context.noPreRollPosition = {
    decisionKind: "checker",
    position: Array(26).fill(0),
    matchLength: 7,
    playerScore: 0,
    opponentScore: 0,
    cubeValue: 1,
    winRate: 0.71,
    loseRate: 0.29,
    gammonWinRate: 0.20,
    gammonLoseRate: 0.05,
    backgammonWinRate: 0.03,
    backgammonLoseRate: 0.01,
    preRollWinRate: null,
    preRollLoseRate: null,
    preRollGammonWinRate: null,
    preRollGammonLoseRate: null,
    preRollBackgammonWinRate: null,
    preRollBackgammonLoseRate: null,
  };
  const html = evaluate("summaryAnalysisHTML(noPreRollPosition)");
  assert.doesNotMatch(html, />71\.0%<\/span>/);
  assert.match(html, />—<\/span>/);
});

run("Double keeps the best-action band fixed with No Double game info and pre-action board", () => {
  context.autoDoublePosition = {
    id: "AUTO-D",
    decisionKind: "double",
    decisionType: "cube",
    position: Array(26).fill(0),
    matchLength: 7,
    playerScore: 1,
    opponentScore: 2,
    cubeValue: 1,
    isCrawford: false,
    isPostCrawford: false,
    winRate: 0.50,
    loseRate: 0.50,
    gammonWinRate: 0.10,
    gammonLoseRate: 0.10,
    backgammonWinRate: 0.01,
    backgammonLoseRate: 0.01,
    quizBoardImage: "assets/boards-quiz/AUTO-D.svg",
    bestAction: "Double/Take",
    candidates: [
      {
        rank: 1,
        action: "No Double",
        equityDifference: -0.04,
        cubeValue: 1,
        cubeOwner: "center",
        actionBoardImage: "assets/boards-actions/AUTO-D-1.svg",
        winRate: 0.51,
        loseRate: 0.49,
        gammonWinRate: 0.10,
        gammonLoseRate: 0.09,
        backgammonWinRate: 0.01,
        backgammonLoseRate: 0.01,
      },
      {
        rank: 2,
        action: "Double/Take",
        equityDifference: null,
        cubeValue: 2,
        cubeOwner: "opponent",
        actionBoardImage: "assets/boards-actions/AUTO-D-2.svg",
        winRate: 0.61,
        loseRate: 0.39,
        gammonWinRate: 0.17,
        gammonLoseRate: 0.07,
        backgammonWinRate: 0.02,
        backgammonLoseRate: 0.01,
      },
    ],
  };

  evaluate("state.current = autoDoublePosition; state.answered = false; state.selectedCubeCandidateIndex = null");
  evaluate("showAnswer()");
  assert.equal(evaluate("state.selectedCubeCandidateIndex"), 1);
  assert.equal(
    evaluate("elements.board.src"),
    "https://example.test/position-drill/assets/boards-quiz/AUTO-D.svg",
  );
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), />51\.0%<\/span>/);
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), />CB<\/span><span class="stat-value ">1<\/span>/);

  evaluate("selectCubeCandidate(0)");
  assert.equal(evaluate("state.selectedCubeCandidateIndex"), 1);
  assert.equal(
    evaluate("elements.board.src"),
    "https://example.test/position-drill/assets/boards-quiz/AUTO-D.svg",
  );
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), />51\.0%<\/span>/);
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), />CB<\/span><span class="stat-value ">1<\/span>/);

  evaluate("selectCubeCandidate(1)");
  assert.equal(evaluate("state.selectedCubeCandidateIndex"), 1);
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), />51\.0%<\/span>/);
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), />CB<\/span><span class="stat-value ">1<\/span>/);
  assert.equal(
    evaluate("elements.board.src"),
    "https://example.test/position-drill/assets/boards-quiz/AUTO-D.svg",
  );

  evaluate("selectCubeCandidate(1)");
  assert.equal(evaluate("state.selectedCubeCandidateIndex"), 1);
  assert.equal(
    evaluate("elements.board.src"),
    "https://example.test/position-drill/assets/boards-quiz/AUTO-D.svg",
  );
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), />51\.0%<\/span>/);
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), />CB<\/span><span class="stat-value ">1<\/span>/);
});

run("Take/Pass keeps the best-action band and pre-offer board fixed", () => {
  context.autoTakePosition = {
    id: "AUTO-T",
    decisionKind: "take",
    decisionType: "cube",
    position: Array(26).fill(0),
    quizPosition: Array(26).fill(0),
    matchLength: 7,
    playerScore: 2,
    opponentScore: 1,
    quizPlayerScore: 1,
    quizOpponentScore: 2,
    cubeValue: 1,
    isCrawford: false,
    isPostCrawford: false,
    quizWinRate: 0.44,
    quizLoseRate: 0.56,
    quizGammonWinRate: 0.08,
    quizGammonLoseRate: 0.13,
    quizBackgammonWinRate: 0.01,
    quizBackgammonLoseRate: 0.02,
    quizBoardImage: "assets/boards-quiz/AUTO-T.svg",
    candidates: [
      {
        rank: 1,
        action: "No Double",
        cubeValue: 1,
        cubeOwner: "center",
        winRate: 0.57,
        loseRate: 0.43,
        gammonWinRate: 0.13,
        gammonLoseRate: 0.08,
        backgammonWinRate: 0.02,
        backgammonLoseRate: 0.01,
      },
      {
        rank: 2,
        action: "Double/Take",
        cubeValue: 2,
        cubeOwner: "opponent",
        winRate: 0.56,
        loseRate: 0.44,
        gammonWinRate: 0.13,
        gammonLoseRate: 0.08,
        backgammonWinRate: 0.02,
        backgammonLoseRate: 0.01,
      },
    ],
    quizCandidates: [
      {
        rank: 1,
        action: "Pass",
        equityDifference: null,
        cubeValue: 2,
        cubeOwner: "onRoll",
        actionBoardImage: "assets/boards-actions/AUTO-T-1.svg",
        winRate: 0,
        loseRate: 1,
        gammonWinRate: 0,
        gammonLoseRate: 0,
        backgammonWinRate: 0,
        backgammonLoseRate: 0,
      },
      {
        rank: 2,
        action: "Take",
        equityDifference: -0.05,
        cubeValue: 2,
        cubeOwner: "onRoll",
        actionBoardImage: "assets/boards-actions/AUTO-T-2.svg",
        winRate: 0.42,
        loseRate: 0.58,
        gammonWinRate: 0.08,
        gammonLoseRate: 0.14,
        backgammonWinRate: 0.01,
        backgammonLoseRate: 0.02,
      },
    ],
  };

  evaluate("state.current = autoTakePosition; state.answered = false; state.selectedCubeCandidateIndex = null");
  evaluate("showAnswer()");
  assert.equal(evaluate("state.selectedCubeCandidateIndex"), 0);
  assert.equal(
    evaluate("elements.board.src"),
    "https://example.test/position-drill/assets/boards-quiz/AUTO-T.svg",
  );
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), />43\.0%<\/span>/);
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), />CB<\/span><span class="stat-value ">1<\/span>/);

  evaluate("selectCubeCandidate(1)");
  assert.equal(evaluate("state.selectedCubeCandidateIndex"), 0);
  assert.equal(
    evaluate("elements.board.src"),
    "https://example.test/position-drill/assets/boards-quiz/AUTO-T.svg",
  );
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), />43\.0%<\/span>/);
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), />CB<\/span><span class="stat-value ">1<\/span>/);

  evaluate("selectCubeCandidate(1)");
  assert.equal(evaluate("state.selectedCubeCandidateIndex"), 0);
  assert.equal(
    evaluate("elements.board.src"),
    "https://example.test/position-drill/assets/boards-quiz/AUTO-T.svg",
  );
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), />43\.0%<\/span>/);
  assert.match(evaluate("elements.summaryAnalysis.innerHTML"), />CB<\/span><span class="stat-value ">1<\/span>/);
});

console.log("All app regression tests passed.");
