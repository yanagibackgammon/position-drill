const pointsG=document.getElementById("points");
const checkersG=document.getElementById("checkers");
const diceG=document.getElementById("dice");
const cubeG=document.getElementById("cube");
const boardSvg=document.getElementById("board");
const gameOverlayG=document.createElementNS("http://www.w3.org/2000/svg","g");
gameOverlayG.setAttribute("id","gameOverlay");
boardSvg.appendChild(gameOverlayG);
const pipInfoG=document.createElementNS("http://www.w3.org/2000/svg","g");
pipInfoG.setAttribute("id","pipInfo");
boardSvg.appendChild(pipInfoG);
const moveAnimationG=document.createElementNS("http://www.w3.org/2000/svg","g");
moveAnimationG.setAttribute("id","moveAnimation");
boardSvg.appendChild(moveAnimationG);
let moveAnimationToken=0;
let moveAnimationRunning=false;
let lastMoveAnimationKey="";
const CHECKER_MOVE_DURATION=500;

const defaultMeta={
  tournamentTitleLine1:"JBS第31期名人戦 準々決勝",
  tournamentTitleLine2:"2025-08-30　25ポイントマッチ　勝てばベスト4",
  blackName:"柳 暢祐",whiteName:"平林 直",blackScore:0,whiteScore:0,matchFile:"",themeColor:"#6B670D",designPreset:"green"
};
const standardPoints=[0,-2,0,0,0,0,5,0,3,0,0,0,-5,5,0,0,0,-3,0,-5,0,0,0,0,2];
const emptyState={
  phase:"empty",score:[0,0],activePlayer:0,position:{points:standardPoints,blackBar:0,whiteBar:0,blackOff:0,whiteOff:0},
  dice:null,cube:{value:1,owner:0},winRate:{black:50,white:50},gammonRate:{black:0,white:0},backgammonRate:{black:0,white:0},analysis:{type:"none"},historyEvent:null
};

const FALLBACK_DESIGN={
  id:"green",name:"グリーン",
  checkers:{player1:"#17382C",player2:"#F7F0DE"},
  winRate:{player1:"#17382C",player2:"#F7F0DE"},
  board:{surface:"#CDBB91",frame:"#173327",pointLight:"#F2E6C6",pointDark:"#3E705B",bar:"#284F3D"}
};
let designPresets=[FALLBACK_DESIGN];
let currentDesign=FALLBACK_DESIGN;
let appliedDesignPresetId="";

let index=0,meta={...defaultMeta},matchData={states:[emptyState]},loadedMatchFile="",socket=null;
let adFiles=[],adIndex=0,adTimer=null;
let lastBigComebackKey="";
let lastBoardDimKey="";
const BIG_COMEBACK_SPEED=3000;
const BIG_COMEBACK_DIM_SPEED=5000;
let pagesTimer=null;
const PLAYBACK_SPEED=3000;
const SCORE_SEQUENCE_SPEED=5000;
let pagesState={index:0,totalSteps:1,playing:false,speed:PLAYBACK_SPEED,mode:"auto"};
const isLocal=()=>location.hostname==="localhost"||location.hostname==="127.0.0.1";
const pageChannel=(!isLocal()&&"BroadcastChannel" in window)?new BroadcastChannel("match-replay-control"):null;
let pagesMetaRevision="";
let pagesMetaPoller=null;

const els={
  stageWrap:document.getElementById("stage-wrap"),stage:document.getElementById("stage"),
  tournamentTitleLine1:document.getElementById("tournamentTitleLine1"),
  tournamentTitleLine2:document.getElementById("tournamentTitleLine2"),
  blackName:document.getElementById("blackName"),whiteName:document.getElementById("whiteName"),
  blackHistoryName:document.getElementById("blackHistoryName"),whiteHistoryName:document.getElementById("whiteHistoryName"),
  blackScore:document.getElementById("blackScore"),whiteScore:document.getElementById("whiteScore"),
  winBarBlack:document.getElementById("winBarBlack"),winBarWhite:document.getElementById("winBarWhite"),
  gammonBarBlack:document.getElementById("gammonBarBlack"),gammonBarWhite:document.getElementById("gammonBarWhite"),
  backgammonBarBlack:document.getElementById("backgammonBarBlack"),backgammonBarWhite:document.getElementById("backgammonBarWhite"),
  blackRateText:document.getElementById("blackRateText"),whiteRateText:document.getElementById("whiteRateText"),
  blackGammonText:document.getElementById("blackGammonText"),whiteGammonText:document.getElementById("whiteGammonText"),
  blackBackgammonText:document.getElementById("blackBackgammonText"),whiteBackgammonText:document.getElementById("whiteBackgammonText"),
  bigComebackText:document.getElementById("bigComebackText"),
  boardDimOverlay:document.getElementById("boardDimOverlay"),
  historyList:document.getElementById("historyList"),
  blackHistoryList:document.getElementById("blackHistoryList"),whiteHistoryList:document.getElementById("whiteHistoryList"),
  analysisContent:document.getElementById("analysisContent"),
  adImage1:document.getElementById("adImage1"),adImage2:document.getElementById("adImage2")
};

const pointLabelCenters=[81.75,126.25,170.75,215.25,259.75,304.25,397.75,442.25,486.75,531.25,575.75,620.25];
function boardInfoTextColor(){
  return contrastText(currentDesign?.board?.surface||"#FFFFFF");
}
function drawPointLabels(activePlayer=1){
  const labelsG=document.getElementById("pointLabels");labelsG.innerHTML="";
  const player2=activePlayer===-1;
  const labelFill=boardInfoTextColor();
  const topNums=player2?[12,11,10,9,8,7,6,5,4,3,2,1]:[13,14,15,16,17,18,19,20,21,22,23,24];
  const bottomNums=player2?[13,14,15,16,17,18,19,20,21,22,23,24]:[12,11,10,9,8,7,6,5,4,3,2,1];
  pointLabelCenters.forEach((cx,i)=>{
    for(const [y,n] of [[18,topNums[i]],[540,bottomNums[i]]]){
      const t=document.createElementNS("http://www.w3.org/2000/svg","text");
      t.setAttribute("x",cx);t.setAttribute("y",y);t.setAttribute("class","point-label");t.setAttribute("fill",labelFill);t.textContent=n;labelsG.appendChild(t);
    }
  });
}
function calculatePips(position){
  const points=position?.points||standardPoints;
  let black=25*Number(position?.blackBar||0);
  let white=25*Number(position?.whiteBar||0);
  for(let p=1;p<=24;p++){
    const v=Number(points[p]||0);
    if(v>0) black += p*v;
    else if(v<0) white += (25-p)*Math.abs(v);
  }
  return {black,white};
}
function drawPipInfo(position){
  pipInfoG.innerHTML="";
  const pips=calculatePips(position);
  const labelFill=boardInfoTextColor();
  for(const [y,text] of [[18,`(${pips.white})`],[540,`(${pips.black})`]]){
    const t=document.createElementNS("http://www.w3.org/2000/svg","text");
    t.setAttribute("x","350.5");
    t.setAttribute("y",String(y));
    t.setAttribute("class","pip-label");
    t.setAttribute("fill",labelFill);
    t.textContent=text;
    pipInfoG.appendChild(t);
  }
}
function trianglePoints(){
  pointsG.innerHTML="";
  const centers=pointLabelCenters,w=44.5;
  for(let i=0;i<12;i++){
    const cx=centers[i],left=cx-w/2;
    const light=currentDesign?.board?.pointLight||"#FFFFFF";
    const dark=currentDesign?.board?.pointDark||"#CFCFCF";
    for(const [top,color] of [[true,i%2===0?light:dark],[false,i%2===0?dark:light]]){
      const p=document.createElementNS("http://www.w3.org/2000/svg","polygon");p.setAttribute("class","point");p.setAttribute("fill",color);
      p.setAttribute("points",top?`${left},30 ${left+w},30 ${cx},251`:`${left},516 ${left+w},516 ${cx},294`);pointsG.appendChild(p);
    }
  }
  drawPointLabels(1);
}
function pointCoord(p){const c=[81.75,126.25,170.75,215.25,259.75,304.25,397.75,442.25,486.75,531.25,575.75,620.25];return p<=12?{x:c[12-p],y:493,dir:-1}:{x:c[p-13],y:53,dir:1};}
function addStack(x,y,dir,n,klass){
  if(!n)return;const max=Math.min(n,5);
  for(let i=0;i<max;i++){const c=document.createElementNS("http://www.w3.org/2000/svg","circle");c.setAttribute("cx",x);c.setAttribute("cy",y+dir*i*43);c.setAttribute("r","21.1");c.setAttribute("class",klass);checkersG.appendChild(c);}
  if(n>5){const t=document.createElementNS("http://www.w3.org/2000/svg","text");t.setAttribute("x",x);t.setAttribute("y",y+dir*4*43);t.setAttribute("class","checker-text");const checkerFill=klass.includes("black")?(currentDesign?.checkers?.player1||"#111111"):(currentDesign?.checkers?.player2||"#FFFFFF");
    t.setAttribute("fill",contrastText(checkerFill));t.textContent=n;checkersG.appendChild(t);}
}
function addBarStack(centerY,n,klass){
  const count=Math.max(0,Number(n)||0);
  if(!count)return;
  // Position Drill / 添付SVG準拠。バーの上下ハーフ中央を基準にし、
  // 2枚なら 38px 間隔。枚数が多い場合だけ自動的に詰めてハーフ内へ収める。
  const spacing=count<=1?0:Math.min(38,190/(count-1));
  const firstY=centerY-spacing*(count-1)/2;
  for(let i=0;i<count;i++){
    const c=document.createElementNS("http://www.w3.org/2000/svg","circle");
    c.setAttribute("cx","350.5");
    c.setAttribute("cy",String(firstY+spacing*i));
    c.setAttribute("r","21.1");
    c.setAttribute("class",klass);
    checkersG.appendChild(c);
  }
}
const BEAR_OFF_GEOMETRY={x:648,w:41,h:12,upperBase:33,lowerBase:501,pitch:12.4,groupGap:4};
function bearOffRectY(index,upper){
  const g=BEAR_OFF_GEOMETRY;
  const gap=Math.floor(index/5)*g.groupGap;
  return upper ? g.upperBase+index*g.pitch+gap : g.lowerBase-index*g.pitch-gap;
}
function addBearOffStack(count,klass,upper){
  const n=Math.max(0,Math.min(15,Number(count)||0));
  if(!n)return;
  // 添付SVGの右端ベアオフトレイに合わせる。15枚でも上下中央に食い込まず、
  // 5枚ごとに小さな間隔を設けて 5 / 5 / 5 のまとまりを読み取りやすくする。
  const g=BEAR_OFF_GEOMETRY;
  for(let i=0;i<n;i++){
    const r=document.createElementNS("http://www.w3.org/2000/svg","rect");
    r.setAttribute("x",String(g.x));
    r.setAttribute("y",String(bearOffRectY(i,upper)));
    r.setAttribute("width",String(g.w));r.setAttribute("height",String(g.h));r.setAttribute("rx","4");
    r.setAttribute("class",klass);checkersG.appendChild(r);
  }
}
function drawCheckers(position){
  checkersG.innerHTML="";const arr=position?.points||standardPoints;
  for(let p=1;p<=24;p++){const v=arr[p]||0;if(!v)continue;const q=pointCoord(p);addStack(q.x,q.y,q.dir,Math.abs(v),v>0?"checker-piece-black":"checker-piece-white");}
  // 添付SVG: 白は上側バー中央 (y=150.5)、黒は下側バー中央 (y=395.5)。
  addBarStack(150.5,position?.whiteBar||0,"checker-piece-white");
  addBarStack(395.5,position?.blackBar||0,"checker-piece-black");
  addBearOffStack(position?.whiteOff||0,"checker-piece-white",true);
  addBearOffStack(position?.blackOff||0,"checker-piece-black",false);
}

function cloneVisualPosition(position){
  return {
    points:(position?.points||Array(25).fill(0)).slice(),
    blackBar:Number(position?.blackBar||0),whiteBar:Number(position?.whiteBar||0),
    blackOff:Number(position?.blackOff||0),whiteOff:Number(position?.whiteOff||0)
  };
}
function moveCheckerClass(activePlayer){return activePlayer===1?"checker-piece-black":"checker-piece-white";}
function ownCountAt(position,point,activePlayer){
  const v=Number(position?.points?.[point]||0);
  return activePlayer===1?Math.max(0,v):Math.max(0,-v);
}
function stackTopCoord(point,count){
  const q=pointCoord(point),i=Math.max(0,Math.min(Math.max(1,count),5)-1);
  return {x:q.x,y:q.y+q.dir*i*43};
}
function barMoveCoord(position,activePlayer){
  const count=Math.max(1,Number(activePlayer===1?position?.blackBar:position?.whiteBar)||1);
  const centerY=activePlayer===1?395.5:150.5;
  const spacing=count<=1?0:Math.min(38,190/(count-1));
  const firstY=centerY-spacing*(count-1)/2;
  // バー中央寄りの一枚から動かす。
  const y=activePlayer===1?firstY:firstY+spacing*(count-1);
  return {x:350.5,y};
}
function bearOffMoveCoord(position,activePlayer){
  const g=BEAR_OFF_GEOMETRY,x=g.x+g.w/2;
  if(activePlayer===1){
    const n=Math.max(0,Math.min(14,Number(position?.blackOff)||0));
    return {x,y:bearOffRectY(n,false)+g.h/2};
  }
  const n=Math.max(0,Math.min(14,Number(position?.whiteOff)||0));
  return {x,y:bearOffRectY(n,true)+g.h/2};
}
function sourceMoveCoord(position,segment,activePlayer){
  if(segment?.source==="bar")return barMoveCoord(position,activePlayer);
  const p=Number(segment?.source);
  if(Number.isInteger(p)&&p>=1&&p<=24)return stackTopCoord(p,ownCountAt(position,p,activePlayer));
  return {x:350.5,y:273};
}
function destinationMoveCoord(positionAfterSource,segment,activePlayer){
  const p=Number(segment?.destination);
  if(Number.isInteger(p)&&p>=1&&p<=24){
    const q=pointCoord(p),own=ownCountAt(positionAfterSource,p,activePlayer);
    const v=Number(positionAfterSource?.points?.[p]||0);
    const opponentBlot=activePlayer===1?v===-1:v===1;
    const i=opponentBlot?0:Math.min(own,4);
    return {x:q.x,y:q.y+q.dir*i*43};
  }
  return bearOffMoveCoord(positionAfterSource,activePlayer);
}
function removeMovingChecker(position,segment,activePlayer){
  const out=cloneVisualPosition(position),sign=activePlayer===1?1:-1;
  if(segment?.source==="bar"){
    if(activePlayer===1)out.blackBar=Math.max(0,out.blackBar-1);else out.whiteBar=Math.max(0,out.whiteBar-1);
  }else{
    const p=Number(segment?.source);if(Number.isInteger(p)&&p>=1&&p<=24)out.points[p]-=sign;
  }
  return out;
}
function finishMovingChecker(positionAfterSource,segment,activePlayer){
  const out=cloneVisualPosition(positionAfterSource),sign=activePlayer===1?1:-1;
  const p=Number(segment?.destination);
  if(Number.isInteger(p)&&p>=1&&p<=24){
    if(activePlayer===1&&out.points[p]===-1){out.points[p]=0;out.whiteBar+=1;}
    else if(activePlayer===-1&&out.points[p]===1){out.points[p]=0;out.blackBar+=1;}
    out.points[p]+=sign;
  }else if(activePlayer===1)out.blackOff+=1;else out.whiteOff+=1;
  return out;
}
function landHitWithoutBar(positionAfterSource,segment,activePlayer){
  const out=cloneVisualPosition(positionAfterSource),sign=activePlayer===1?1:-1;
  const p=Number(segment?.destination);
  if(!Number.isInteger(p)||p<1||p>24)return out;
  out.points[p]=sign;
  return out;
}
function finishHitToBar(positionAfterLanding,activePlayer){
  const out=cloneVisualPosition(positionAfterLanding);
  const hitPlayer=-activePlayer;
  if(hitPlayer===1)out.blackBar+=1;else out.whiteBar+=1;
  return out;
}
function easeCheckerMove(t){return t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;}
function animateCheckerBetween(from,to,activePlayer,token){
  return new Promise(resolve=>{
    if(token!==moveAnimationToken){resolve(false);return;}
    const c=document.createElementNS("http://www.w3.org/2000/svg","circle");
    c.setAttribute("cx",String(from.x));c.setAttribute("cy",String(from.y));c.setAttribute("r","21.1");
    c.setAttribute("class",moveCheckerClass(activePlayer));
    moveAnimationG.appendChild(c);
    const started=performance.now();
    const frame=now=>{
      if(token!==moveAnimationToken){c.remove();resolve(false);return;}
      const t=Math.min(1,(now-started)/CHECKER_MOVE_DURATION),e=easeCheckerMove(t);
      c.setAttribute("cx",String(from.x+(to.x-from.x)*e));
      c.setAttribute("cy",String(from.y+(to.y-from.y)*e));
      if(t>=1){c.remove();resolve(true);return;}
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
function cancelCheckerAnimation(){
  moveAnimationToken+=1;moveAnimationRunning=false;moveAnimationG.innerHTML="";
}
async function runCheckerAnimation(state,key){
  const token=++moveAnimationToken;
  moveAnimationRunning=true;moveAnimationG.innerHTML="";
  let board=cloneVisualPosition(state.moveAnimation.beforePosition);
  drawCheckers(board);
  for(const segment of state.moveAnimation.segments||[]){
    if(token!==moveAnimationToken)return;
    const from=sourceMoveCoord(board,segment,state.activePlayer);
    const withoutSource=removeMovingChecker(board,segment,state.activePlayer);
    const to=destinationMoveCoord(withoutSource,segment,state.activePlayer);
    drawCheckers(withoutSource);
    const completed=await animateCheckerBetween(from,to,state.activePlayer,token);
    if(!completed||token!==moveAnimationToken)return;
    if(segment?.hit){
      const destination=Number(segment.destination);
      const hitPlayer=-state.activePlayer;
      const landed=landHitWithoutBar(withoutSource,segment,state.activePlayer);
      drawCheckers(landed);
      const q=pointCoord(destination);
      const afterHit=finishHitToBar(landed,state.activePlayer);
      const hitTo=barMoveCoord(afterHit,hitPlayer);
      const hitCompleted=await animateCheckerBetween({x:q.x,y:q.y},hitTo,hitPlayer,token);
      if(!hitCompleted||token!==moveAnimationToken)return;
      board=afterHit;
    }else{
      board=finishMovingChecker(withoutSource,segment,state.activePlayer);
    }
    drawCheckers(board);
  }
  if(token!==moveAnimationToken)return;
  moveAnimationRunning=false;moveAnimationG.innerHTML="";
  drawCheckers(state.position);
}
function renderAnimatedCheckers(state){
  const eligible=(state?.phase==="analysis"||(state?.phase==="candidates"&&state?.forcedMove))&&state?.moveAnimation&&Array.isArray(state.moveAnimation.segments)&&state.moveAnimation.segments.length>0;
  const key=`${loadedMatchFile}|${index}`;
  if(!eligible){
    if(moveAnimationRunning)cancelCheckerAnimation();
    lastMoveAnimationKey="";moveAnimationG.innerHTML="";drawCheckers(state?.position);return;
  }
  if(lastMoveAnimationKey!==key){
    if(moveAnimationRunning)cancelCheckerAnimation();
    lastMoveAnimationKey=key;
    runCheckerAnimation(state,key);
    return;
  }
  if(!moveAnimationRunning)drawCheckers(state.position);
}
function drawDice(vals,activePlayer,{luckKind=null,muted=false}={}){
  diceG.innerHTML="";
  diceG.classList.toggle("is-joker-glow",luckKind==="joker"&&!muted);
  diceG.classList.toggle("is-antijoker-glow",luckKind==="antiJoker"&&!muted);
  diceG.classList.toggle("is-muted",Boolean(muted));
  if(!vals)return;const spots={1:[[18,18]],2:[[10,10],[26,26]],3:[[10,10],[18,18],[26,26]],4:[[10,10],[26,10],[10,26],[26,26]],5:[[10,10],[26,10],[18,18],[10,26],[26,26]],6:[[10,9],[26,9],[10,18],[26,18],[10,27],[26,27]]};
  const player1=activePlayer===1;
  const face=normalizeHex(player1?currentDesign?.checkers?.player1:currentDesign?.checkers?.player2,player1?"#111111":"#FFFFFF");
  const pip=contrastText(face);
  const border=(getComputedStyle(document.documentElement).getPropertyValue("--die-border")||"#111111").trim()||"#111111";
  function die(x,y,n){const g=document.createElementNS("http://www.w3.org/2000/svg","g"),r=document.createElementNS("http://www.w3.org/2000/svg","rect");r.setAttribute("x",x);r.setAttribute("y",y);r.setAttribute("width",36);r.setAttribute("height",36);r.setAttribute("rx",4);r.setAttribute("fill",face);r.setAttribute("stroke",border);r.setAttribute("stroke-width","1.5");g.appendChild(r);(spots[n]||[]).forEach(([dx,dy])=>{const c=document.createElementNS("http://www.w3.org/2000/svg","circle");c.setAttribute("cx",x+dx);c.setAttribute("cy",y+dy);c.setAttribute("r","3.4");c.setAttribute("fill",pip);g.appendChild(c);});return g;}
  // Player 1 is shown in the center of the right half; Player 2 in the center of the left half.
  const xs=player1?[468.5,514.5]:[151.5,197.5];
  diceG.appendChild(die(xs[0],254,vals[0]));diceG.appendChild(die(xs[1],254,vals[1]));
}
function drawCube(cube){
  cubeG.innerHTML="";
  const value=Math.max(1,Number(cube?.value)||1);
  const owner=cube?.owner||0;
  // 添付SVG準拠: センターはバー中央、白所有は上端、黒所有は下端。
  const y=owner==="white"?35:(owner==="black"?475:255);
  const r=document.createElementNS("http://www.w3.org/2000/svg","rect");
  r.setAttribute("x","332.5");r.setAttribute("y",String(y));r.setAttribute("width","36");r.setAttribute("height","36");r.setAttribute("rx","3");
  r.setAttribute("fill","#fff");r.setAttribute("stroke","#000");r.setAttribute("stroke-width","1.5");cubeG.appendChild(r);
  const t=document.createElementNS("http://www.w3.org/2000/svg","text");
  t.setAttribute("x","350.5");t.setAttribute("y",String(y+25));t.setAttribute("text-anchor","middle");t.setAttribute("fill","#000");
  t.setAttribute("font-family","Arial, Helvetica, sans-serif");t.setAttribute("font-size","23");t.textContent=value;cubeG.appendChild(t);
}
function drawGameOverlay(state){
  gameOverlayG.innerHTML="";
  if(!state) return;

  const addPanel=(x,y,w,h,rx=18)=>{
    const r=document.createElementNS("http://www.w3.org/2000/svg","rect");
    r.setAttribute("x",String(x));r.setAttribute("y",String(y));r.setAttribute("width",String(w));r.setAttribute("height",String(h));r.setAttribute("rx",String(rx));
    r.setAttribute("fill","rgba(0,0,0,.84)");r.setAttribute("stroke","rgba(255,255,255,.9)");r.setAttribute("stroke-width","2");
    gameOverlayG.appendChild(r);
  };
  const addText=(y,text,size,color="#fff",weight=800)=>{
    const t=document.createElementNS("http://www.w3.org/2000/svg","text");
    t.setAttribute("x","351");t.setAttribute("y",String(y));t.setAttribute("text-anchor","middle");t.setAttribute("fill",color);
    t.setAttribute("font-family","Arial, Helvetica, sans-serif");t.setAttribute("font-size",String(size));t.setAttribute("font-weight",String(weight));
    t.textContent=text;gameOverlayG.appendChild(t);
  };

  if(state.phase==="matchStart"){
    addPanel(96,188,510,170,18);
    addText(246,"試合開始",46,"#fff",900);
    addText(316,`${meta.blackName} vs ${meta.whiteName}`,34,"#fff",800);
    return;
  }

  if(state.phase==="matchEnd"){
    const winner=state.matchWinner;
    const winnerName=winner==="black"?meta.blackName:winner==="white"?meta.whiteName:"";
    addPanel(116,150,470,246,18);
    addText(212,"試合終了",42,"#fff",900);
    addText(270,"勝者",30,"#fff",800);
    addText(344,winnerName,54,"#fff",900);
    return;
  }

  if(state.phase==="gameStart"){
    addPanel(246,232,210,82,14);
    addText(286,`Game ${state.gameNumber || 1}`,42,"#fff",700);
    return;
  }
  if(state.phase!=="gameEnd" || !state.scoreDelta) return;

  const winner=state.scoreDelta.winner;
  const points=Math.max(0,Number(state.scoreDelta.points)||0);
  const cubeValue=Math.max(1,Number(state.cube?.value)||1);
  const winMultiplier=Math.max(1,Math.min(3,Math.round(points/cubeValue)||1));
  const winnerName=winner==="black"?meta.blackName:meta.whiteName;
  const winLabel=winMultiplier>=3?"バックギャモン勝ち":winMultiplier===2?"ギャモン勝ち":"シングル勝ち";

  addPanel(116,165,470,216,18);
  addText(220,winnerName,32,"#fff",800);
  addText(300,`＋${points}`,72,"#18b86b",900);
  addText(350,`${winLabel}・キューブ${cubeValue}倍`,28,"#fff",800);
}
trianglePoints();

function normalizeThemeColor(value){
  const text=String(value||"").trim();
  return /^#[0-9a-fA-F]{6}$/.test(text)?text:"#6B670D";
}

function normalizeHex(value,fallback){
  const text=String(value||"").trim();
  return /^#[0-9a-fA-F]{6}$/.test(text)?text:fallback;
}
function contrastText(hex){
  const color=normalizeHex(hex,"#FFFFFF").slice(1);
  const r=parseInt(color.slice(0,2),16),g=parseInt(color.slice(2,4),16),b=parseInt(color.slice(4,6),16);
  const lum=(r*299+g*587+b*114)/1000;
  return lum>=150?"#111111":"#FFFFFF";
}
function gammonTone(hex){
  const color=normalizeHex(hex,"#808080").slice(1);
  const rgb=[0,2,4].map(i=>parseInt(color.slice(i,i+2),16));
  const lum=(rgb[0]*299+rgb[1]*587+rgb[2]*114)/1000;
  const target=lum>=150?0:255;
  const ratio=0.22;
  const mixed=rgb.map(v=>Math.round(v*(1-ratio)+target*ratio));
  return `#${mixed.map(v=>v.toString(16).padStart(2,"0")).join("")}`;
}
function findDesignPreset(id){
  return designPresets.find(p=>p&&p.id===id)||designPresets[0]||FALLBACK_DESIGN;
}
function applyDesignPreset(id){
  const next=findDesignPreset(id||"green");
  currentDesign=next;
  if(appliedDesignPresetId===next.id) return;
  appliedDesignPresetId=next.id;
  const root=document.documentElement;
  const checkerPlayer1=normalizeHex(next.checkers?.player1,"#111111");
  const checkerPlayer2=normalizeHex(next.checkers?.player2,"#FFFFFF");
  root.style.setProperty("--checker-player1",checkerPlayer1);
  root.style.setProperty("--checker-player2",checkerPlayer2);
  root.style.setProperty("--die-player1",checkerPlayer1);
  root.style.setProperty("--die-player2",checkerPlayer2);
  root.style.setProperty("--die-player1-pip",contrastText(checkerPlayer1));
  root.style.setProperty("--die-player2-pip",contrastText(checkerPlayer2));
  const winPlayer1=normalizeHex(next.winRate?.player1,"#111111");
  const winPlayer2=normalizeHex(next.winRate?.player2,"#FFFFFF");
  root.style.setProperty("--win-player1",winPlayer1);
  root.style.setProperty("--win-player2",winPlayer2);
  root.style.setProperty("--gammon-player1",gammonTone(winPlayer1));
  root.style.setProperty("--gammon-player2",gammonTone(winPlayer2));
  root.style.setProperty("--board-surface",normalizeHex(next.board?.surface,"#FFFFFF"));
  root.style.setProperty("--point-light",normalizeHex(next.board?.pointLight,"#FFFFFF"));
  root.style.setProperty("--point-dark",normalizeHex(next.board?.pointDark,"#CFCFCF"));
  root.style.setProperty("--board-bar",normalizeHex(next.board?.bar,"#111111"));
  const boardFrame=normalizeHex(next.board?.frame,"#000000");
  root.style.setProperty("--board-line",boardFrame);

  const directBg=boardSvg.firstElementChild;
  if(directBg&&directBg.tagName.toLowerCase()==="rect") directBg.setAttribute("fill",normalizeHex(next.board?.surface,"#FFFFFF"));
  const baseRects=[...document.querySelectorAll("#boardBase rect")];
  if(baseRects[0]) baseRects[0].setAttribute("fill",normalizeHex(next.board?.surface,"#FFFFFF"));
  if(baseRects[1]) baseRects[1].setAttribute("fill",boardFrame);
  if(baseRects[2]) baseRects[2].setAttribute("fill",boardFrame);
  // 外周・中央バー周り・左右端など、盤面の区切り線はすべて frame で統一する。
  document.querySelectorAll("#boardBase rect, #boardBase line").forEach(el=>el.setAttribute("stroke",boardFrame));
  trianglePoints();
}
async function loadDesignPresets(){
  try{
    const u=new URL("./design-presets.json",location.href);u.searchParams.set("t",Date.now());
    const r=await fetch(u,{cache:"no-store"});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const data=await r.json();
    if(Array.isArray(data.presets)&&data.presets.length) designPresets=data.presets;
  }catch(error){
    console.warn("Failed to load design presets; using fallback.",error);
    designPresets=[FALLBACK_DESIGN];
  }
  appliedDesignPresetId="";
  applyDesignPreset(meta.designPreset||"green");
  render();
}

function ensureHistoryHeader(el){
  if(!el)return {pr:null,name:null};
  let pr=el.querySelector('.history-pr');
  let name=el.querySelector('.history-name-text');
  if(!pr||!name){
    el.textContent='';
    pr=document.createElement('span');pr.className='history-pr';
    name=document.createElement('span');name.className='history-name-text';
    el.append(pr,name);
  }
  return {pr,name};
}
function renderHistoryHeader(el,prValue,nameText){
  const parts=ensureHistoryHeader(el);
  if(parts.pr)parts.pr.textContent=`PR ${Number(prValue||0).toFixed(2)}`;
  if(parts.name)parts.name.textContent=nameText||'';
}
function renderMeta(state){
  document.documentElement.style.setProperty("--theme-color",normalizeThemeColor(meta.themeColor));
  applyDesignPreset(meta.designPreset||"green");
  els.tournamentTitleLine1.textContent=meta.tournamentTitleLine1;
  els.tournamentTitleLine2.textContent=meta.tournamentTitleLine2||"";
  els.blackName.textContent=meta.blackName;els.whiteName.textContent=meta.whiteName;
  renderHistoryHeader(els.blackHistoryName,state?.pr?.black,meta.blackName);
  renderHistoryHeader(els.whiteHistoryName,state?.pr?.white,meta.whiteName);
  const score=state?.score||[meta.blackScore,meta.whiteScore];
  const blackGain=state?.scoreDelta?.winner==='black'?Number(state.scoreDelta.points)||0:0;
  const whiteGain=state?.scoreDelta?.winner==='white'?Number(state.scoreDelta.points)||0:0;
  function renderScoreValue(el,value,gain){
    if(!el)return;
    const gainNow=gain>0;
    if(gainNow){
      const oldScore=Number(value)||0;
      const newScore=oldScore+gain;
      const key=`${state?.gameNumber||0}-${index}-${oldScore}-${gain}-${newScore}`;
      if(el.dataset.scoreGainKey!==key){
        el.dataset.scoreGainKey=key;
        el.classList.add('is-score-transition');
        el.innerHTML=`<span class="score-number score-number-old">${oldScore}</span><span class="score-number score-number-gain">＋${gain}</span><span class="score-number score-number-new">${newScore}</span>`;
      }
    }else{
      el.dataset.scoreGainKey='';
      el.classList.remove('is-score-transition');
      el.textContent=value;
    }
  }
  renderScoreValue(els.blackScore,score[0]??meta.blackScore,blackGain);
  renderScoreValue(els.whiteScore,score[1]??meta.whiteScore,whiteGain);
}
function diePips(face){return {1:["p5"],2:["p1","p9"],3:["p1","p5","p9"],4:["p1","p3","p7","p9"],5:["p1","p3","p5","p7","p9"],6:["p1","p3","p4","p6","p7","p9"]}[face]||[];}
function diePlayerClass(player){return player===1||player==="black"?"player1":"player2";}
function renderDie(face,player){return `<span class="die ${diePlayerClass(player)}">${diePips(face).map(c=>`<span class="die-pip ${c}"></span>`).join("")}</span>`;}
function renderPair(pair,player){return pair&&pair.length===2?`<div class="dice-pair-inline">${renderDie(pair[0],player)}${renderDie(pair[1],player)}</div>`:'<div class="dice-pair-inline"></div>';}
function renderHistoryCube(value){
  const raw=String(value??"").trim().toUpperCase();
  const shown=raw==="P"?"P":Math.max(2,Number(value)||2);
  return `<div class="history-cube-pair"><span class="history-icon-spacer"></span><span class="history-cube-icon">${shown}</span></div>`;
}
function historyClass(error){
  const loss=Math.abs(Number(error)||0);
  if(loss>=0.080)return"history-blunder";
  if(loss>=0.020)return"history-error";
  return"";
}
function candidateErrorClass(error){const value=Number(error);if(value<=-0.080)return"error-purple";if(value<=-0.020)return"error-red";return"";}
function historyMoveLabel(move){return move==="Dance"?"Cannot Move":(move||"");}
function historyCell(event,player){
  if(!event)return '<div class="history-cell"></div>';
  const icon=event.kind==="cube"
    ? renderHistoryCube(event.cubeValue)
    : event.kind==="cubeResponse"
      ? renderHistoryCube(event.move==="Pass"?"P":event.cubeValue)
      : renderPair(event.dice,player);
  return `<div class="history-cell ${historyClass(event.error)}">${icon}<span class="history-move">${historyMoveLabel(event.move)}</span></div>`;
}
function collectHistoryRows(){
  const rows=[];
  const cubeRows=new Map();
  let leadPlayer=null;
  let openMoveRow=null;
  for(let stateIndex=0;stateIndex<=index&&stateIndex<matchData.states.length;stateIndex++){
    const state=matchData.states[stateIndex];
    if(!state)continue;
    if(state.phase==="gameStart"){
      rows.push({kind:"game",gameNumber:Number(state.gameNumber)||1});
      leadPlayer=null;openMoveRow=null;cubeRows.clear();
      continue;
    }

    // 各ゲームで最初に手番を迎えた側を先行とする。
    // 先行のpreRoll（手番開始）が来た時点で、ムーブ表示前でも次の行を先に作る。
    if(state.phase==="preRoll"){
      const turnPlayer=state.activePlayer===1?"black":(state.activePlayer===-1?"white":null);
      if(turnPlayer){
        if(!leadPlayer)leadPlayer=turnPlayer;
        if(turnPlayer===leadPlayer){openMoveRow={kind:"actions",black:null,white:null};rows.push(openMoveRow);}
      }
    }

    // Legacy generated JSON compatibility.
    const grouped=Array.isArray(state.historyEvents)?state.historyEvents.filter(Boolean):[];
    if(grouped.length){
      const row={kind:"actions",black:null,white:null};
      for(const event of grouped){if(event.player==="black"||event.player==="white")row[event.player]=event;}
      rows.push(row);openMoveRow=null;continue;
    }

    const event=state.historyEvent;
    if(event&&(event.player==="black"||event.player==="white")){
      if(event.kind==="cube"){
        const row={kind:"actions",black:null,white:null};
        row[event.player]=event;rows.push(row);openMoveRow=null;
        if(event.pairId)cubeRows.set(event.pairId,row);
        continue;
      }
      if(event.kind==="cubeResponse"){
        let row=event.pairId?cubeRows.get(event.pairId):null;
        if(!row){row={kind:"actions",black:null,white:null};rows.push(row);if(event.pairId)cubeRows.set(event.pairId,row);}
        const pairedOffer=row.black?.kind==="cube"?row.black:(row.white?.kind==="cube"?row.white:null);
        row[event.player]=event.cubeValue?event:{...event,cubeValue:pairedOffer?.cubeValue};
        openMoveRow=null;continue;
      }
      if(!leadPlayer)leadPlayer=event.player;
      const existingEvent=openMoveRow?.[event.player]||null;
      // 直前のrollで同じセルにダイスだけ入っている場合は、そのセルをムーブで置き換える。
      // これにより「ロール表示」と「候補手表示」を分けても履歴行は増えない。
      if(!openMoveRow||(existingEvent&&existingEvent.kind!=="roll")){openMoveRow={kind:"actions",black:null,white:null};rows.push(openMoveRow);}
      openMoveRow[event.player]=event;
      continue;
    }

    // ロールした瞬間は、現在行にダイスだけ先に表示する。
    // 初手はpreRollを省略するため、roll自体が先行行の開始にもなる。
    if(state.phase==="roll"&&Array.isArray(state.dice)){
      const turnPlayer=state.activePlayer===1?"black":(state.activePlayer===-1?"white":null);
      if(turnPlayer){
        if(!leadPlayer)leadPlayer=turnPlayer;
        if(turnPlayer===leadPlayer&&(!openMoveRow||openMoveRow[turnPlayer])){openMoveRow={kind:"actions",black:null,white:null};rows.push(openMoveRow);}
        if(!openMoveRow||openMoveRow[turnPlayer]){openMoveRow={kind:"actions",black:null,white:null};rows.push(openMoveRow);}
        openMoveRow[turnPlayer]={player:turnPlayer,dice:state.dice,move:"",error:0,kind:"roll"};
      }
    }
  }
  return rows.slice(-4);
}
function renderHistory(){
  const rows=collectHistoryRows();
  // v36で履歴DOM構造を変更したため、Pages/OBSのキャッシュでHTMLとJSの
  // 世代が一時的にずれても描画全体を止めないよう新旧DOMの両方に対応する。
  if(els.historyList){
    const padded=[...Array(Math.max(0,4-rows.length)).fill(null),...rows].slice(-4);
    els.historyList.innerHTML=padded.map(row=>{
      if(!row)return `<div class="history-timeline-row history-empty-row">${historyCell(null,"black")}${historyCell(null,"white")}</div>`;
      if(row.kind==="game")return `<div class="history-timeline-row history-game-row"><div class="history-game-label">Game ${row.gameNumber}</div></div>`;
      return `<div class="history-timeline-row">${historyCell(row.black,"black")}${historyCell(row.white,"white")}</div>`;
    }).join("");
    return;
  }
  if(els.blackHistoryList&&els.whiteHistoryList){
    els.blackHistoryList.innerHTML=rows.map(row=>row.kind==="game"?`<div class="history-row">Game ${row.gameNumber}</div>`:historyCell(row.black,"black")).join("");
    els.whiteHistoryList.innerHTML=rows.map(row=>row.kind==="game"?'<div class="history-row"></div>':historyCell(row.white,"white")).join("");
  }
}
function renderAnalysis(a){
  if(!a||a.type==="none"){els.analysisContent.innerHTML="";return;}
  if(a.type==="jokers"){
    const activePlayer=currentState().activePlayer===1?1:-1;
    const rollOrder=[
      [6,6],[6,5],[6,4],[6,3],[6,2],[6,1],
      [5,5],[5,4],[5,3],[5,2],[5,1],
      [4,4],[4,3],[4,2],[4,1],
      [3,3],[3,2],[3,1],
      [2,2],[2,1],[1,1]
    ];
    const key=d=>{
      const x=Number(d?.[0]),y=Number(d?.[1]);
      return Number.isFinite(x)&&Number.isFinite(y)?`${Math.max(x,y)}-${Math.min(x,y)}`:"";
    };
    const orderedItems=(rolls,kind)=>{
      const keys=new Set((Array.isArray(rolls)?rolls:[]).map(key).filter(Boolean));
      const fullFaces=new Set();
      for(let face=1;face<=6;face++){
        const related=[1,2,3,4,5,6].map(other=>`${Math.max(face,other)}-${Math.min(face,other)}`);
        if(related.every(k=>keys.has(k))) fullFaces.add(face);
      }
      const emittedFaces=new Set();
      const items=[];
      for(const dice of rollOrder){
        const diceKey=key(dice);
        if(!keys.has(diceKey)) continue;
        const groupedFaces=[...fullFaces].filter(face=>dice.includes(face)&&!emittedFaces.has(face));
        if(groupedFaces.length){
          const face=groupedFaces.sort((a,b)=>b-a)[0];
          emittedFaces.add(face);
          items.push({kind,face,single:true});
          continue;
        }
        if([...fullFaces].some(face=>dice.includes(face))) continue;
        items.push({kind,dice,single:false});
      }
      return items;
    };
    const renderItem=item=>{
      const label=item.kind==="plus"?"チャンス！":"ピンチ！";
      if(item.single){
        return `<div class="joker-glow ${item.kind} is-single-face"><div class="joker-label">${label}</div><div class="single-die-block">${renderDie(item.face,activePlayer)}</div></div>`;
      }
      return `<div class="joker-glow ${item.kind}"><div class="joker-label">${label}</div><div class="dice-pair-block">${renderDie(item.dice[0],activePlayer)}${renderDie(item.dice[1],activePlayer)}</div></div>`;
    };
    // 表示順は固定：チャンスを先に、その後にピンチ。
    // 各カテゴリ内は 66,65,64,63,62,61,55,...,21,11 の順で対象出目だけを表示する。
    const chanceItems=orderedItems(a.joker,"plus");
    const pinchItems=orderedItems(a.antiJoker,"minus");
    const items=[...chanceItems,...pinchItems];
    els.analysisContent.innerHTML=`<div class="analysis-jokers${items.length>6?" is-many":""}">${items.map(renderItem).join("")}</div>`;return;
  }
  const selectedIndex=Number.isInteger(a.playedIndex)?a.playedIndex:-1;
  const all=a.candidates||[];
  let visible=all.slice(0,5).map((c,i)=>({candidate:c,index:i}));
  // 選択手が6位以下の場合は、5行目を実際の選択手に置き換える。
  if(selectedIndex>=5 && all[selectedIndex]){
    const entry={candidate:all[selectedIndex],index:selectedIndex};
    if(visible.length<5)visible.push(entry);else visible[4]=entry;
  }
  const rows=visible.map(({candidate:c,index:i})=>{
    const errorClass=candidateErrorClass(c.error);
    const selected=i===selectedIndex;
    const selectedClass=selected?(errorClass==="error-purple"?" is-selected is-selected-blunder":errorClass==="error-red"?" is-selected is-selected-error":" is-selected"):"";
    return `<div class="analysis-row${selectedClass}"><span class="analysis-move">${historyMoveLabel(c.move)}</span><span class="analysis-eq ${errorClass}">${Number(c.error??0).toFixed(3)}</span></div>`;
  });
  while(rows.length<5) rows.push('<div class="analysis-row analysis-row-empty"><span class="analysis-move"></span><span class="analysis-eq"></span></div>');
  els.analysisContent.innerHTML=`<div class="analysis-moves">${rows.slice(0,5).join("")}</div>`;
}
function currentState(){return matchData.states[Math.max(0,Math.min(index,matchData.states.length-1))]||emptyState;}
function resetBoardDimOverlay(){
  const el=els.boardDimOverlay;if(!el)return;
  lastBoardDimKey="";
  el.classList.remove("is-active");
}
function renderBoardDimOverlay(state){
  const el=els.boardDimOverlay;if(!el)return;
  const isIntro=state?.phase==="bigComebackIntro" && Boolean(state?.bigComeback);
  if(!isIntro){
    resetBoardDimOverlay();
    return;
  }
  const key=`${index}:${state.gameNumber||0}:${state.activePlayer||0}`;
  if(key===lastBoardDimKey) return;
  lastBoardDimKey=key;
  el.classList.remove("is-active");
  void el.offsetWidth;
  el.classList.add("is-active");
}
function renderBigComeback(state){
  const el=els.bigComebackText;if(!el)return;
  const notice=state?.phase==="roll" ? state?.rollNotice : null;
  const isVisible=notice==="comeback" || notice==="nice";
  if(!isVisible){
    lastBigComebackKey="";
    el.classList.remove("is-active","is-comeback","is-nice");
    el.setAttribute("aria-hidden","true");
    return;
  }
  el.textContent=notice==="comeback"?"大逆転！":"ナイスロール！";
  el.classList.toggle("is-comeback",notice==="comeback");
  el.classList.toggle("is-nice",notice==="nice");
  const key=`${index}:${state.gameNumber||0}:${state.activePlayer||0}:${notice}`;
  el.setAttribute("aria-hidden","false");
  if(key===lastBigComebackKey) return;
  lastBigComebackKey=key;
  el.classList.remove("is-active");
  void el.offsetWidth;
  el.classList.add("is-active");
}
function render(){
  const s=currentState();
  // 手番変更後のpreRollでは盤面もまだ変化していないため、勝率バー類は直前の表示値を維持する。
  // 実際のロール状態に進んだ瞬間だけ、そのロール後の解析値へアニメーションさせる。
  const previousState=index>0?matchData.states[index-1]:null;
  const rateState=(s?.phase==="preRoll"&&previousState?.gameNumber===s.gameNumber)?previousState:s;
  const b=Number(rateState?.winRate?.black??50),w=Number(rateState?.winRate?.white??(100-b));renderMeta(s);
  const gb=Math.max(0,Math.min(b,Number(rateState?.gammonRate?.black??0)));
  const gw=Math.max(0,Math.min(w,Number(rateState?.gammonRate?.white??0)));
  const rawBgb=Math.max(0,Number(rateState?.backgammonRate?.black??0));
  const rawBgw=Math.max(0,Number(rateState?.backgammonRate?.white??0));
  const bgb=Math.max(0,Math.min(gb,rawBgb));
  const bgw=Math.max(0,Math.min(gw,rawBgw));
  const showBgb=bgb>=5;
  const showBgw=bgw>=5;
  const displayBlack=Math.round(b),displayWhite=100-displayBlack;
  els.winBarBlack.style.width=`${b}%`;els.winBarWhite.style.width=`${w}%`;
  els.winBarBlack.classList.toggle("is-zero",b<=0);
  els.winBarWhite.classList.toggle("is-zero",w<=0);
  els.gammonBarBlack.style.width=`${gb}%`;els.gammonBarWhite.style.width=`${gw}%`;
  els.gammonBarBlack.classList.toggle("is-zero",gb<=0);els.gammonBarWhite.classList.toggle("is-zero",gw<=0);
  els.backgammonBarBlack.style.width=`${showBgb?bgb:0}%`;els.backgammonBarWhite.style.width=`${showBgw?bgw:0}%`;
  els.backgammonBarBlack.classList.toggle("is-zero",!showBgb);els.backgammonBarWhite.classList.toggle("is-zero",!showBgw);
  els.blackRateText.innerHTML=`${displayBlack}<span class="bar-rate-percent">%</span>`;els.whiteRateText.innerHTML=`${displayWhite}<span class="bar-rate-percent">%</span>`;
  const blackGText=`G ${Math.round(gb)}%`;
  const whiteGText=`G ${Math.round(gw)}%`;
  const blackBgText=showBgb?`BG ${Math.round(bgb)}%`:"";
  const whiteBgText=showBgw?`BG ${Math.round(bgw)}%`:"";
  // 勝率・G率・BG率は同一行で、約全角スペース1文字分の等間隔に配置する。
  els.blackGammonText.textContent=blackGText;
  els.whiteGammonText.textContent=whiteGText;
  if(els.blackBackgammonText)els.blackBackgammonText.textContent=blackBgText;
  if(els.whiteBackgammonText)els.whiteBackgammonText.textContent=whiteBgText;
  renderBigComeback(s);
  renderBoardDimOverlay(s);
  els.blackHistoryName.classList.toggle("active-turn",s.activePlayer===1);
  els.whiteHistoryName.classList.toggle("active-turn",s.activePlayer===-1);
  drawPointLabels(s.activePlayer);drawPipInfo(s.position);renderAnimatedCheckers(s);drawDice(s.dice,s.activePlayer,{luckKind:s.luckKind||null,muted:Boolean(s.diceMuted)});drawCube(s.cube);drawGameOverlay(s);renderHistory();renderAnalysis(s.analysis);
}

async function fetchManifest(){try{const u=new URL("./matches/manifest.json",location.href);u.searchParams.set("t",Date.now());const r=await fetch(u,{cache:"no-store"});return r.ok?await r.json():{};}catch{return {};}}
async function loadMatch(file,{force=false,resetIndex=false}={}){
  if(!file){
    loadedMatchFile="";
    matchData={states:[emptyState]};
    index=0;
    if(!isLocal()){
      pagesState.index=0;
      pagesState.totalSteps=1;
      publishPagesState();
    }
    render();
    return true;
  }
  if(!force && file===loadedMatchFile && matchData.states.length>1) return true;
  try{
    let url;
    if(isLocal()) url=`/api/match?file=${encodeURIComponent(file)}&t=${Date.now()}`;
    else{
      const m=await fetchManifest();
      const rel=m.generated?.[file]||(/\.xg$/i.test(file)?`generated/${file}.json`:file);
      url=new URL(`./matches/${rel}`,location.href);
      url.searchParams.set("t",Date.now());
      url=url.toString();
    }
    const r=await fetch(url,{cache:"no-store"});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const data=await r.json();
    if(!Array.isArray(data.states)||!data.states.length) throw new Error("No replay states");
    matchData=data;
    loadedMatchFile=file;
    if(resetIndex) index=0;
    index=Math.max(0,Math.min(index,data.states.length-1));
    if(!isLocal()){
      pagesState.totalSteps=data.states.length;
      pagesState.index=index;
      publishPagesState();
    }
    render();
    return true;
  }catch(error){
    console.error("Failed to load match",error);
    loadedMatchFile="";
    matchData={states:[emptyState]};
    index=0;
    if(!isLocal()){
      pagesState.index=0;
      pagesState.totalSteps=1;
      pagesState.playing=false;
      publishPagesState({matchError:String(error.message||error)});
    }
    render();
    return false;
  }
}
async function applyStateMessage(message){
  if(typeof message.index==="number") index=message.index;
  const old=meta.matchFile;
  if(message.meta) meta={...meta,...message.meta};
  if(meta.matchFile!==old||meta.matchFile!==loadedMatchFile) await loadMatch(meta.matchFile,{force:true,resetIndex:meta.matchFile!==old});
  render();
}

function publishPagesState(extra={}){
  if(isLocal()) return;
  const payload={type:"state",...pagesState,meta:{...meta},...extra};
  try{localStorage.setItem("matchReplayPlaybackState",JSON.stringify(payload));}catch{}
  if(pageChannel) pageChannel.postMessage(payload);
}
function playbackDelayForIndex(i){
  const state=matchData.states[Math.max(0,Math.min(Number(i)||0,matchData.states.length-1))];
  if(state?.phase==="gameEnd" || state?.phase==="matchStart" || state?.phase==="matchEnd") return SCORE_SEQUENCE_SPEED;
  if(state?.phase==="bigComebackIntro") return BIG_COMEBACK_DIM_SPEED;
  if(state?.phase==="roll" && (state?.rollNotice==="comeback" || state?.rollNotice==="nice")) return BIG_COMEBACK_SPEED;
  const segments=Array.isArray(state?.moveAnimation?.segments)?state.moveAnimation.segments:[];
  if(segments.length){
    const hitCount=segments.reduce((n,s)=>n+(s?.hit?1:0),0);
    const animationMs=(segments.length+hitCount)*CHECKER_MOVE_DURATION+250;
    return Math.max(PLAYBACK_SPEED,animationMs);
  }
  return PLAYBACK_SPEED;
}
function stopPagesTimer(){if(pagesTimer){clearTimeout(pagesTimer);pagesTimer=null;}}
function startPagesTimer(){
  stopPagesTimer();
  if(!pagesState.playing || pagesState.mode!=="auto") return;
  pagesTimer=setTimeout(()=>{
    pagesTimer=null;
    const last=Math.max(0,pagesState.totalSteps-1);
    if(pagesState.index>=last){
      pagesState.index=last;pagesState.playing=false;publishPagesState();return;
    }
    pagesState.index+=1;index=pagesState.index;render();publishPagesState();
    startPagesTimer();
  },playbackDelayForIndex(pagesState.index));
}
function handlePagesCommand(command,value){
  pagesState.speed=PLAYBACK_SPEED;
  switch(command){
    case "setMode":
      pagesState.mode=value==="manual"?"manual":"auto";
      pagesState.playing=false;stopPagesTimer();
      break;
    case "play":
      if(pagesState.mode==="auto"){pagesState.playing=true;startPagesTimer();}
      break;
    case "pause": pagesState.playing=false;stopPagesTimer();break;
    case "prev": pagesState.playing=false;stopPagesTimer();pagesState.index=Math.max(0,pagesState.index-1);break;
    case "next": pagesState.playing=false;stopPagesTimer();pagesState.index=Math.min(Math.max(0,pagesState.totalSteps-1),pagesState.index+1);break;
    case "seek": pagesState.playing=false;stopPagesTimer();pagesState.index=Math.max(0,Math.min(Math.max(0,pagesState.totalSteps-1),Number(value)||0));break;
  }
  index=pagesState.index;render();publishPagesState();
}

async function applyPagesMeta(nextMeta,{force=false}={}){
  if(isLocal()||!nextMeta||typeof nextMeta!=="object") return;
  const oldFile=meta.matchFile;
  meta={...meta,...nextMeta};
  const fileChanged=meta.matchFile!==oldFile;
  if(force||fileChanged||meta.matchFile!==loadedMatchFile){
    await loadMatch(meta.matchFile,{force:true,resetIndex:fileChanged});
  }
  if(fileChanged){
    pagesState.index=0;
    index=0;
  }
  render();
  publishPagesState();
}

function startPagesMetaPolling(){
  if(isLocal()||pagesMetaPoller) return;
  try{pagesMetaRevision=localStorage.getItem("matchReplayMetaRevision")||"";}catch{}
  pagesMetaPoller=setInterval(async()=>{
    try{
      const revision=localStorage.getItem("matchReplayMetaRevision")||"";
      if(!revision||revision===pagesMetaRevision) return;
      pagesMetaRevision=revision;
      const raw=localStorage.getItem("matchReplayMeta");
      if(!raw) return;
      await applyPagesMeta(JSON.parse(raw),{force:true});
    }catch(error){
      console.warn("Failed to synchronize display settings",error);
    }
  },300);
}

async function loadInitialPagesMeta(){
  if(isLocal())return;
  try{const r=await fetch(new URL("./stream-config.json",location.href),{cache:"no-store"});if(r.ok)meta={...meta,...await r.json()};}catch{}
  try{const s=localStorage.getItem("matchReplayMeta");if(s)meta={...meta,...JSON.parse(s)};pagesMetaRevision=localStorage.getItem("matchReplayMetaRevision")||"";}catch{}
  try{const s=localStorage.getItem("matchReplayPlaybackState");if(s){const p=JSON.parse(s);pagesState={...pagesState,...p,speed:PLAYBACK_SPEED};index=Number(p.index)||0;}}catch{}
  pagesState.speed=PLAYBACK_SPEED;
  await loadMatch(meta.matchFile,{force:true});
  pagesState.index=Math.max(0,Math.min(index,pagesState.totalSteps-1));
  index=pagesState.index;
  render();publishPagesState();
}
function connectWebSocket(){
  if(!isLocal())return;const protocol=location.protocol==="https:"?"wss:":"ws:";socket=new WebSocket(`${protocol}//${location.host}/ws`);
  socket.addEventListener("open",()=>socket.send(JSON.stringify({type:"hello",role:"display"})));
  socket.addEventListener("message",async e=>{try{const m=JSON.parse(e.data);if(m.type==="state")await applyStateMessage(m);}catch(err){console.warn(err);}});
  socket.addEventListener("close",()=>setTimeout(connectWebSocket,1500));
}
if(pageChannel)pageChannel.addEventListener("message",async e=>{
  const m=e.data||{};
  if(m.type==="meta"){
    if(m.revision) pagesMetaRevision=String(m.revision);
    await applyPagesMeta(m.meta,{force:true});
  }else if(m.type==="command"){
    handlePagesCommand(m.command,m.value);
  }else if(m.type==="state-request"){
    publishPagesState();
  }
});
addEventListener("storage",async e=>{
  if(isLocal()) return;
  try{
    if(e.key==="matchReplayMetaRevision"){
      pagesMetaRevision=e.newValue||"";
      const raw=localStorage.getItem("matchReplayMeta");
      if(raw) await applyPagesMeta(JSON.parse(raw),{force:true});
    }else if(e.key==="matchReplayMeta"&&e.newValue){
      await applyPagesMeta(JSON.parse(e.newValue),{force:true});
    }
  }catch(error){console.warn("Failed to synchronize display settings",error);}
});

async function loadAds(){
  try{let r;if(isLocal())r=await fetch("/api/ads",{cache:"no-store"});else{const u=new URL("./ads/manifest.json",location.href);u.searchParams.set("t",Date.now());r=await fetch(u,{cache:"no-store"});}const d=await r.json();adFiles=Array.isArray(d.files)?d.files:[];}catch{adFiles=[];}
}
function setAdImage(el,file){
  if(!file){el.hidden=true;el.removeAttribute("src");return;}
  el.src=`./ads/${encodeURIComponent(file)}`;el.hidden=false;
}
async function cycleAds(){
  await loadAds();
  if(!adFiles.length){setAdImage(els.adImage1,null);setAdImage(els.adImage2,null);return;}
  const first=adFiles[adIndex%adFiles.length];
  const second=adFiles.length>1?adFiles[(adIndex+1)%adFiles.length]:null;
  setAdImage(els.adImage1,first);setAdImage(els.adImage2,second);
  adIndex=(adIndex+2)%adFiles.length;
}
function startAdRotation(){if(adTimer)clearInterval(adTimer);cycleAds();adTimer=setInterval(cycleAds,60000);}
function scaleStage(){const vw=document.documentElement.clientWidth||innerWidth||1920,s=vw/1920;els.stage.style.transform=`scale(${s})`;els.stageWrap.style.height=`${Math.ceil(1080*s)}px`;}
addEventListener("resize",scaleStage);scaleStage();render();loadDesignPresets();startAdRotation();loadInitialPagesMeta();startPagesMetaPolling();connectWebSocket();
