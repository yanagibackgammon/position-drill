const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RECORD_SIZE = 2560;
const JOKER_EQUITY_THRESHOLD = 0.300;
const JOKER_WINRATE_THRESHOLD = JOKER_EQUITY_THRESHOLD; // legacy export name

function int8(buf, off){ return buf.readInt8(off); }
function uint8(buf, off){ return buf.readUInt8(off); }
function int16(buf, off){ return buf.readInt16LE(off); }
function int32(buf, off){ return buf.readInt32LE(off); }
function uint32(buf, off){ return buf.readUInt32LE(off); }
function float32(buf, off){ return buf.readFloatLE(off); }
function float64(buf, off){ return buf.readDoubleLE(off); }

function readShortString(buf, off, maxLen){
  const len = Math.min(uint8(buf, off), maxLen);
  return buf.subarray(off + 1, off + 1 + len).toString('latin1');
}

function readUtf16Fixed(buf, off, count){
  let end = off;
  for(let i=0;i<count;i++){
    if(buf.readUInt16LE(off + i * 2) === 0) break;
    end = off + (i + 1) * 2;
  }
  if(end <= off) return '';
  return buf.subarray(off, end).toString('utf16le');
}

function delphiDateToIso(days){
  if(!Number.isFinite(days)) return '';
  const epoch = Date.UTC(1899, 11, 30);
  const d = new Date(epoch + days * 86400000);
  if(Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for(let n=0;n<256;n++){
    let c=n;
    for(let k=0;k<8;k++) c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);
    table[n]=c>>>0;
  }
  return table;
})();

function crc32(buf){
  let c=0xffffffff;
  for(const b of buf) c=CRC32_TABLE[(c^b)&0xff]^(c>>>8);
  return (c^0xffffffff)>>>0;
}

function extractArchive(raw){
  if(raw.length < 8268) throw new Error('XG file is too small');
  const magic = Buffer.from(raw.subarray(0,4)).reverse().toString('ascii');
  const headerVersion = int32(raw, 4);
  const headerSize = int32(raw, 8);
  const thumbnailSize = int32(raw, 20);
  if(magic !== 'HMGR' || headerVersion !== 1) throw new Error('Invalid RichGame header');

  const arcOff = raw.length - 36;
  const archiveCrc = uint32(raw, arcOff);
  const fileCount = int32(raw, arcOff + 4);
  const archiveVersion = int32(raw, arcOff + 8);
  const registrySize = int32(raw, arcOff + 12);
  const archiveSize = int32(raw, arcOff + 16);
  const compressedRegistry = int32(raw, arcOff + 20) !== 0;
  const registryStart = arcOff - registrySize;
  const archiveDataStart = registryStart - archiveSize;
  if(archiveDataStart < headerSize + thumbnailSize - 4) throw new Error('Invalid archive offsets');

  const crcRegion = raw.subarray(archiveDataStart, arcOff);
  if(crc32(crcRegion) !== archiveCrc) throw new Error('XG archive CRC mismatch');

  let registry = raw.subarray(registryStart, arcOff);
  if(compressedRegistry) registry = zlib.inflateSync(registry);

  const files = {};
  for(let i=0;i<fileCount;i++){
    const off = i * 532;
    const name = readShortString(registry, off, 255);
    const originalSize = int32(registry, off + 512);
    const compressedSize = int32(registry, off + 516);
    const start = int32(registry, off + 520);
    const expectedCrc = uint32(registry, off + 524);
    const compressed = uint8(registry, off + 528) === 0;
    const segment = raw.subarray(archiveDataStart + start);
    let out;
    if(compressed){
      out = zlib.inflateSync(segment);
    }else{
      out = segment.subarray(0, compressedSize);
    }
    if(out.length !== originalSize) throw new Error(`Unexpected size for ${name}`);
    if(crc32(out) !== expectedCrc) throw new Error(`CRC mismatch for ${name}`);
    files[name] = out;
  }

  return {files, headerSize, thumbnailSize, archiveVersion};
}

function normalizeStoredPosition(pos){
  const points = Array(25).fill(0);
  for(let p=1;p<=24;p++) points[p] = Number(pos[p] || 0);
  const blackBar = Math.max(0, Number(pos[25] || 0));
  const whiteBar = Math.max(0, -Number(pos[0] || 0));
  const blackOnBoard = points.slice(1).reduce((sum,v)=>sum+Math.max(0,Number(v)||0),0) + blackBar;
  const whiteOnBoard = points.slice(1).reduce((sum,v)=>sum+Math.max(0,-(Number(v)||0)),0) + whiteBar;
  return {
    points,
    blackBar,
    whiteBar,
    blackOff: Math.max(0, 15 - blackOnBoard),
    whiteOff: Math.max(0, 15 - whiteOnBoard)
  };
}

function normalizeMoveEndPosition(pos, activePlayer){
  if(activePlayer === 1) return normalizeStoredPosition(pos);
  const points = Array(25).fill(0);
  for(let p=1;p<=24;p++) points[25 - p] = -Number(pos[p] || 0);
  const blackBar = Math.max(0, -Number(pos[0] || 0));
  const whiteBar = Math.max(0, Number(pos[25] || 0));
  const blackOnBoard = points.slice(1).reduce((sum,v)=>sum+Math.max(0,Number(v)||0),0) + blackBar;
  const whiteOnBoard = points.slice(1).reduce((sum,v)=>sum+Math.max(0,-(Number(v)||0)),0) + whiteBar;
  return {
    points,
    blackBar,
    whiteBar,
    blackOff: Math.max(0, 15 - blackOnBoard),
    whiteOff: Math.max(0, 15 - whiteOnBoard)
  };
}

function cloneBoardPosition(position){
  return {
    points: (position?.points || Array(25).fill(0)).slice(),
    blackBar: Number(position?.blackBar || 0),
    whiteBar: Number(position?.whiteBar || 0),
    blackOff: Number(position?.blackOff || 0),
    whiteOff: Number(position?.whiteOff || 0)
  };
}

function canonicalPointFromMoveIndex(index, activePlayer){
  if(index == null || index < 0) return null;
  if(index === 24) return 'bar';
  return activePlayer === 1 ? index + 1 : 24 - index;
}

function applyCheckerMove(beforePosition, activePlayer, raw){
  const board = cloneBoardPosition(beforePosition);
  const sign = activePlayer === 1 ? 1 : -1;
  const segments = [];

  for(let i=0;i<8;i+=2){
    const from = Number(raw[i]);
    const to = Number(raw[i+1]);
    if(!Number.isFinite(from) || from < 0) break;

    const source = canonicalPointFromMoveIndex(from, activePlayer);
    const destination = to < 0 ? null : canonicalPointFromMoveIndex(to, activePlayer);
    let hit = false;

    if(source === 'bar'){
      if(sign === 1) board.blackBar = Math.max(0, board.blackBar - 1);
      else board.whiteBar = Math.max(0, board.whiteBar - 1);
    }else if(Number.isInteger(source) && source >= 1 && source <= 24){
      board.points[source] -= sign;
    }

    if(destination != null){
      if(sign === 1 && board.points[destination] === -1){
        board.points[destination] = 0;
        board.whiteBar += 1;
        hit = true;
      }else if(sign === -1 && board.points[destination] === 1){
        board.points[destination] = 0;
        board.blackBar += 1;
        hit = true;
      }
      board.points[destination] += sign;
    }else{
      if(sign === 1) board.blackOff += 1;
      else board.whiteOff += 1;
    }

    segments.push({from,to,source,destination,hit});
  }

  return {position:board,segments};
}

function formatCheckerMove(raw, beforePosition, activePlayer){
  const applied = applyCheckerMove(beforePosition, activePlayer, raw);
  if(!applied.segments.length) return 'Cannot Move';

  // XG式ムーブ表記。
  // - Bar は先頭大文字、bear-off は off。
  // - 同一チェッカーの連続移動は、途中でヒットしていなければ1本にまとめる。
  //   例: 24/20 20/16 -> 24/16、Bar/20 20/15 -> Bar/15。
  // - 途中でヒットした場合は経路を分ける。
  //   例: Bar/21* 21/15*。
  // - 同一路線は (2)(3) のようにまとめ、いずれかがヒットなら * を付ける。
  // 盤面アニメーション用の applied.segments 自体は変更しない。
  const paths=[];
  for(const seg of applied.segments){
    // 同じ地点に到達済みの経路が複数ある場合、XG表記に近づけるため
    // 先に到達した経路を優先する。最初の到達がヒットなら連結しない。
    const firstEnding=paths.find(path=>path.to===seg.from && path.to>=0);
    if(firstEnding && !firstEnding.lastHit){
      firstEnding.to=seg.to;
      firstEnding.hit=Boolean(seg.hit);
      firstEnding.lastHit=Boolean(seg.hit);
      firstEnding.steps+=1;
    }else{
      paths.push({
        from:seg.from,
        to:seg.to,
        hit:Boolean(seg.hit),
        lastHit:Boolean(seg.hit),
        steps:1
      });
    }
  }

  const pointText=value=>{
    if(value===24) return 'Bar';
    if(value<0) return 'off';
    return String(value+1);
  };
  const sourceSortValue=value=>value===24?100:value+1;
  const destinationSortValue=value=>value<0?0:value+1;

  // XGと同様に Bar を最優先し、その後は大きい起点から並べる。
  // 同一起点では大きい着点（短い移動）を先にする。
  paths.sort((a,b)=>{
    const sourceDiff=sourceSortValue(b.from)-sourceSortValue(a.from);
    if(sourceDiff) return sourceDiff;
    const destinationDiff=destinationSortValue(b.to)-destinationSortValue(a.to);
    if(destinationDiff) return destinationDiff;
    return 0;
  });

  const compact=[];
  for(const path of paths){
    const route=`${pointText(path.from)}/${pointText(path.to)}`;
    const last=compact[compact.length-1];
    if(last && last.route===route){
      last.count+=1;
      last.hit=last.hit||path.hit;
    }else{
      compact.push({route,count:1,hit:path.hit});
    }
  }

  return compact.map(item=>`${item.route}${item.hit?'*':''}${item.count>1?`(${item.count})`:''}`).join(' ');
}

function positionKey(position,activePlayer){
  const pts=(position?.points||[]).slice(1,25).join(',');
  return `${activePlayer}|${pts}|${Number(position?.blackBar||0)}|${Number(position?.whiteBar||0)}|${Number(position?.blackOff||0)}|${Number(position?.whiteOff||0)}`;
}

function countChecker(position,player,point){
  const v=Number(position?.points?.[point]||0);
  return player===1?Math.max(0,v):Math.max(0,-v);
}
function barCount(position,player){return player===1?Number(position?.blackBar||0):Number(position?.whiteBar||0);}
function offCount(position,player){return player===1?Number(position?.blackOff||0):Number(position?.whiteOff||0);}
function isBlocked(position,player,point){
  const v=Number(position?.points?.[point]||0);
  return player===1?v<=-2:v>=2;
}
function allInHome(position,player){
  if(barCount(position,player)>0)return false;
  if(player===1){
    for(let p=7;p<=24;p++)if(countChecker(position,player,p)>0)return false;
  }else{
    for(let p=1;p<=18;p++)if(countChecker(position,player,p)>0)return false;
  }
  return true;
}
function canBearOffFrom(position,player,point,die){
  if(!allInHome(position,player))return false;
  if(player===1){
    if(point===die)return true;
    if(point>die)return false;
    for(let p=point+1;p<=6;p++)if(countChecker(position,player,p)>0)return false;
    return true;
  }
  const distance=25-point;
  if(distance===die)return true;
  if(distance>die)return false;
  for(let p=19;p<point;p++)if(countChecker(position,player,p)>0)return false;
  return true;
}
function applyGeneratedMove(position,player,source,destination){
  const board=cloneBoardPosition(position),sign=player===1?1:-1;
  if(source==='bar'){
    if(player===1)board.blackBar=Math.max(0,board.blackBar-1);else board.whiteBar=Math.max(0,board.whiteBar-1);
  }else board.points[source]-=sign;
  if(destination==='off'){
    if(player===1)board.blackOff+=1;else board.whiteOff+=1;
    return board;
  }
  if(player===1&&board.points[destination]===-1){board.points[destination]=0;board.whiteBar+=1;}
  else if(player===-1&&board.points[destination]===1){board.points[destination]=0;board.blackBar+=1;}
  board.points[destination]+=sign;
  return board;
}
function singleDieMoves(position,player,die){
  const out=[];
  const bar=barCount(position,player);
  if(bar>0){
    const destination=player===1?25-die:die;
    if(destination>=1&&destination<=24&&!isBlocked(position,player,destination))out.push(applyGeneratedMove(position,player,'bar',destination));
    return out;
  }
  for(let p=1;p<=24;p++){
    if(countChecker(position,player,p)<=0)continue;
    const destination=player===1?p-die:p+die;
    if(destination>=1&&destination<=24){
      if(!isBlocked(position,player,destination))out.push(applyGeneratedMove(position,player,p,destination));
    }else if(canBearOffFrom(position,player,p,die))out.push(applyGeneratedMove(position,player,p,'off'));
  }
  return out;
}
function generatedPositionKey(position){return `${(position.points||[]).slice(1,25).join(',')}|${position.blackBar}|${position.whiteBar}|${position.blackOff}|${position.whiteOff}`;}
function generateRollPositions(position,player,d1,d2){
  const orders=d1===d2?[[d1,d1,d1,d1]]:[[d1,d2],[d2,d1]];
  const terminals=[];
  for(const dice of orders){
    const walk=(board,idx,used)=>{
      if(idx>=dice.length){terminals.push({position:board,used:[...used]});return;}
      const die=dice[idx],moves=singleDieMoves(board,player,die);
      if(!moves.length){walk(board,idx+1,used);return;}
      for(const next of moves)walk(next,idx+1,[...used,die]);
    };
    walk(cloneBoardPosition(position),0,[]);
  }
  let maxUsed=0;for(const t of terminals)maxUsed=Math.max(maxUsed,t.used.length);
  let filtered=terminals.filter(t=>t.used.length===maxUsed);
  if(d1!==d2&&maxUsed===1){
    const high=Math.max(d1,d2);
    if(filtered.some(t=>t.used[0]===high))filtered=filtered.filter(t=>t.used[0]===high);
  }
  const unique=new Map();
  for(const t of filtered){const key=generatedPositionKey(t.position);if(!unique.has(key))unique.set(key,t.position);}
  return unique.size?[...unique.values()]:[cloneBoardPosition(position)];
}
function pipCount(position,player){
  let total=barCount(position,player)*25;
  for(let p=1;p<=24;p++){
    const n=countChecker(position,player,p);
    total+=n*(player===1?p:25-p);
  }
  return total;
}
function madeHomePoints(position,player){
  let n=0;
  if(player===1){for(let p=1;p<=6;p++)if(countChecker(position,player,p)>=2)n++;}
  else{for(let p=19;p<=24;p++)if(countChecker(position,player,p)>=2)n++;}
  return n;
}
function blotCount(position,player){let n=0;for(let p=1;p<=24;p++)if(countChecker(position,player,p)===1)n++;return n;}
function staticEquityProxy(position,player){
  const opp=-player;
  const pipAdv=pipCount(position,opp)-pipCount(position,player);
  const offAdv=offCount(position,player)-offCount(position,opp);
  const barAdv=barCount(position,opp)-barCount(position,player);
  const homeAdv=madeHomePoints(position,player)-madeHomePoints(position,opp);
  const blotAdv=blotCount(position,opp)-blotCount(position,player);
  return 0.008*pipAdv+0.10*offAdv+0.16*barAdv+0.03*homeAdv+0.02*blotAdv;
}
function contextOutcomeEquity(context,player){
  const blackW=Number(context?.winRate?.black),whiteW=Number(context?.winRate?.white);
  if(!Number.isFinite(blackW)||!Number.isFinite(whiteW))return NaN;
  const activeW=(player===1?blackW:whiteW)/100;
  const activeG=Number(player===1?context?.gammonRate?.black:context?.gammonRate?.white)||0;
  const oppG=Number(player===1?context?.gammonRate?.white:context?.gammonRate?.black)||0;
  const activeBG=Number(player===1?context?.backgammonRate?.black:context?.backgammonRate?.white)||0;
  const oppBG=Number(player===1?context?.backgammonRate?.white:context?.backgammonRate?.black)||0;
  return (2*activeW-1)+(activeG+activeBG-oppG-oppBG)/100;
}
function terminalPointValue(position,winner){
  const loser=-winner;
  if(offCount(position,winner)<15)return null;
  if(offCount(position,loser)>0)return 1;
  let loserInWinnersHome=barCount(position,loser)>0;
  if(!loserInWinnersHome){
    if(winner===1){for(let p=1;p<=6;p++)if(countChecker(position,loser,p)>0){loserInWinnersHome=true;break;}}
    else{for(let p=19;p<=24;p++)if(countChecker(position,loser,p)>0){loserInWinnersHome=true;break;}}
  }
  return loserInWinnersHome?3:2;
}
function hitExposure(position,victim){
  const attacker=-victim,beforeBar=barCount(position,victim);
  let hitFaces=0;
  for(let die=1;die<=6;die++){
    const moves=singleDieMoves(position,attacker,die);
    if(moves.some(next=>barCount(next,victim)>beforeBar))hitFaces++;
  }
  const miss=(6-hitFaces)/6;
  return {hitFaces,probability:1-miss*miss,blots:blotCount(position,victim)};
}
function postRollEquityProxy(position,player,basePosition,context){
  const terminal=terminalPointValue(position,player);
  if(terminal!==null)return terminal;
  const opp=-player;
  const baseEq=contextOutcomeEquity(context,player);
  if(!Number.isFinite(baseEq))return staticEquityProxy(position,player);
  const baseExposure=hitExposure(basePosition,player);
  const nextExposure=hitExposure(position,player);
  const pipGain=pipCount(basePosition,player)-pipCount(position,player);
  const offGain=offCount(position,player)-offCount(basePosition,player);
  const oppBarGain=barCount(position,opp)-barCount(basePosition,opp);
  const ownBarReduction=barCount(basePosition,player)-barCount(position,player);
  const homeGain=madeHomePoints(position,player)-madeHomePoints(basePosition,player);
  const activeG=(Number(player===1?context?.gammonRate?.black:context?.gammonRate?.white)||0)/100;
  const oppG=(Number(player===1?context?.gammonRate?.white:context?.gammonRate?.black)||0)/100;
  const activeBG=(Number(player===1?context?.backgammonRate?.black:context?.backgammonRate?.white)||0)/100;
  const oppBG=(Number(player===1?context?.backgammonRate?.white:context?.backgammonRate?.black)||0)/100;
  const outcomeLeverage=Math.min(1,activeG+oppG+activeBG+oppBG);
  const exposureWeight=0.35+0.65*outcomeLeverage;
  return baseEq
    +0.006*pipGain
    +0.04*offGain
    +0.10*oppBarGain
    +0.10*ownBarReduction
    +0.03*homeGain
    -exposureWeight*(nextExposure.probability-baseExposure.probability)
    -0.05*(nextExposure.blots-baseExposure.blots);
}
const jokerRollCache=new Map();
function directBarEntryHitFaces(position,player){
  // 盤面予測だけで判定するための戦術補正。
  // バーに1枚だけあり、特定の面で「エンターと同時にヒット」できる場合は、
  // その面を含む全出目が大きなチャンスになりやすい。
  if(barCount(position,player)!==1)return [];
  const opponent=-player;
  const beforeOppBar=barCount(position,opponent);
  const faces=[];
  for(let die=1;die<=6;die++){
    const moves=singleDieMoves(position,player,die);
    const canEnterAndHit=moves.some(next=>
      barCount(next,player)===0 && barCount(next,opponent)>beforeOppBar
    );
    if(canEnterAndHit)faces.push(die);
  }
  return faces;
}
function isOutcomeLockedForJoker(context){
  const black=Number(context?.winRate?.black);
  const white=Number(context?.winRate?.white);
  const blackG=Math.abs(Number(context?.gammonRate?.black)||0);
  const whiteG=Math.abs(Number(context?.gammonRate?.white)||0);
  const winLocked=(Number.isFinite(black)&&Number.isFinite(white)) && (black>=99.95||black<=0.05||white>=99.95||white<=0.05);
  const gammonFlat=blackG<0.05&&whiteG<0.05;
  return winLocked&&gammonFlat;
}
function analyzeJokerRolls(position,activePlayer,context=null){
  // XGの実勝率がほぼ100/0（または0/100）で、双方のG率もほぼ0なら、
  // 出目による実質的なエクイティ差はないものとして候補表示を抑止する。
  // 簡易PIP評価がベアオフ枚数の差を「チャンス」と誤認するのを防ぐ。
  if(isOutcomeLockedForJoker(context)){
    return {joker:[],antiJoker:[],thresholdEquity:JOKER_EQUITY_THRESHOLD,averageEquityProxy:null,source:'xg-outcome-locked'};
  }
  const contextKey=context?`${Number(context?.winRate?.black??NaN).toFixed(3)}|${Number(context?.gammonRate?.black??0).toFixed(3)}|${Number(context?.gammonRate?.white??0).toFixed(3)}|${Number(context?.backgammonRate?.black??0).toFixed(3)}|${Number(context?.backgammonRate?.white??0).toFixed(3)}`:'na';
  const key=`${positionKey(position,activePlayer)}|${contextKey}`;
  if(jokerRollCache.has(key))return jokerRollCache.get(key);
  const rolls=[];
  let weighted=0,totalWeight=0;
  for(let hi=1;hi<=6;hi++)for(let lo=1;lo<=hi;lo++){
    const positions=generateRollPositions(position,activePlayer,hi,lo);
    let best=-Infinity;
    for(const next of positions)best=Math.max(best,postRollEquityProxy(next,activePlayer,position,context));
    if(!Number.isFinite(best))best=postRollEquityProxy(position,activePlayer,position,context);
    const weight=hi===lo?1:2;
    rolls.push({dice:[hi,lo],equity:best,weight});weighted+=best*weight;totalWeight+=weight;
  }
  const average=totalWeight?weighted/totalWeight:postRollEquityProxy(position,activePlayer,position,context);
  for(const r of rolls)r.luck=r.equity-average;
  let joker=rolls.filter(r=>r.luck>=JOKER_EQUITY_THRESHOLD).sort((a,b)=>b.luck-a.luck).map(r=>r.dice);
  let antiJoker=rolls.filter(r=>r.luck<=-JOKER_EQUITY_THRESHOLD).sort((a,b)=>a.luck-b.luck).map(r=>r.dice);

  // 戦術補正も「直後の実際のロール」ではなく、現在の盤面だけから判定する。
  // バーに1枚だけあり、ある面でエンターしながら相手ブロットを直接ヒットできる場合、
  // その面を含む全6種類の出目をチャンス候補に含める。
  // バーに2枚以上ある場合は、1枚だけ入って残りがバーに残るケースを一括で良い目にしない。
  const tacticalHitFaces=directBarEntryHitFaces(position,activePlayer);
  if(tacticalHitFaces.length){
    const jokerKeys=new Set(joker.map(rollKey));
    const antiKeys=new Set(antiJoker.map(rollKey));
    for(const face of tacticalHitFaces){
      for(let other=1;other<=6;other++){
        const dice=[Math.max(face,other),Math.min(face,other)];
        const k=rollKey(dice);
        antiKeys.delete(k);
        if(!jokerKeys.has(k)){joker.push(dice);jokerKeys.add(k);}
      }
    }
    antiJoker=antiJoker.filter(d=>antiKeys.has(rollKey(d)));
  }

  const result={joker,antiJoker,thresholdEquity:JOKER_EQUITY_THRESHOLD,averageEquityProxy:average,source:'standalone-roll-evaluator',tacticalBarEntryHitFaces:tacticalHitFaces};
  jokerRollCache.set(key,result);return result;
}
function rollKey(dice){if(!Array.isArray(dice)||dice.length<2)return'';const a=Number(dice[0]),b=Number(dice[1]);return `${Math.max(a,b)}-${Math.min(a,b)}`;}
function classifyRollLuck(analysis,dice){
  const key=rollKey(dice);if(!key)return null;
  if((analysis?.joker||[]).some(d=>rollKey(d)===key))return'joker';
  if((analysis?.antiJoker||[]).some(d=>rollKey(d)===key))return'antiJoker';
  return null;
}
function cubeValueFromCode(code){
  if(!code) return 1;
  return 2 ** Math.abs(code);
}

function cubeOwnerFromCode(code){
  if(!code) return 0;
  // XG stores cube ownership absolutely: positive = Player 1 / black,
  // negative = Player 2 / white. It must never flip just because the turn changes.
  return code > 0 ? 'black' : 'white';
}

function readPosition(buf, off){
  const out = [];
  for(let i=0;i<26;i++) out.push(int8(buf, off + i));
  return out;
}

function samePosition(a,b){
  if(!a || !b || a.length !== b.length) return false;
  for(let i=0;i<a.length;i++) if(a[i] !== b[i]) return false;
  return true;
}

function parseBestMoveEngine(rec, base){
  const nMoves = Math.max(0, Math.min(32, int32(rec, base + 64)));
  const posBase = base + 68;
  const moveBase = base + 900;
  const evalBase = base + 1284;
  const candidates = [];
  for(let i=0;i<nMoves;i++){
    const pos = readPosition(rec, posBase + i * 26);
    const moveRaw = [];
    for(let j=0;j<8;j++) moveRaw.push(int8(rec, moveBase + i*8 + j));
    const result = [];
    for(let j=0;j<7;j++) result.push(float32(rec, evalBase + i*28 + j*4));
    candidates.push({
      pos,
      moveRaw,
      move: '',
      result,
      winRate: result[3] * 100,
      gammonRate: result[4] * 100,
      opponentGammonRate: result[1] * 100,
      backgammonRate: result[5] * 100,
      opponentBackgammonRate: result[0] * 100,
      equity: result[6]
    });
  }
  const unused = int8(rec, base + 2180);
  return {nMoves, candidates, unused};
}

function parseDoubleEngine(rec, base){
  const result = [];
  const resultDouble = [];
  for(let i=0;i<7;i++) result.push(float32(rec, base + 60 + i*4));
  for(let i=0;i<7;i++) resultDouble.push(float32(rec, base + 104 + i*4));
  return {
    level: int32(rec, base + 28),
    cube: int32(rec, base + 40),
    cubePos: int32(rec, base + 44),
    flagDouble: int16(rec, base + 56),
    result,
    equityNoDouble: float32(rec, base + 88),
    equityDoubleTake: float32(rec, base + 92),
    equityDrop: float32(rec, base + 96),
    resultDouble
  };
}

function blackRateFromActive(activePlayer, activeRate){
  if(!Number.isFinite(activeRate)) return null;
  return activePlayer === 1 ? activeRate : 100 - activeRate;
}

function clampRate(v){ return Math.max(0, Math.min(100, v)); }

function parseHeaderMatch(rec){
  const version = int32(rec, 552);
  const ansi1 = readShortString(rec, 9, 40);
  const ansi2 = readShortString(rec, 50, 40);
  const matchLength = int32(rec, 92);
  const date = delphiDateToIso(float64(rec, 128));
  let event = '';
  let player1 = ansi1;
  let player2 = ansi2;
  let location = '';
  let round = '';
  if(version >= 24){
    event = readUtf16Fixed(rec, 622, 129);
    player1 = readUtf16Fixed(rec, 880, 129) || ansi1;
    player2 = readUtf16Fixed(rec, 1138, 129) || ansi2;
    location = readUtf16Fixed(rec, 1396, 129);
    round = readUtf16Fixed(rec, 1654, 129);
  }
  return {version, matchLength, date, event, player1, player2, location, round};
}

function parseGameHeader(rec, version){
  const score1 = int32(rec, 12);
  const score2 = int32(rec, 16);
  const crawford = uint8(rec, 20) !== 0;
  const pos = readPosition(rec, 21);
  const gameNumber = int32(rec, 48);
  const autoDoubles = version >= 26 ? int32(rec, 64) : 0;
  return {score1, score2, crawford, pos, gameNumber, autoDoubles};
}

function parseMove(rec, version){
  const positionI = readPosition(rec, 9);
  const positionEnd = readPosition(rec, 35);
  const activePlayer = int32(rec, 64);
  const moveRaw = [];
  for(let i=0;i<8;i++) moveRaw.push(int32(rec, 68 + i*4));
  const dice = [int32(rec,100), int32(rec,104)];
  const cubeCode = int32(rec,108);
  const best = parseBestMoveEngine(rec,124);
  const errMove = float64(rec,2312);
  const errLuck = float64(rec,2320);
  const initEq = float64(rec,2336);
  const invalidM = int32(rec,2480);
  let playedIndex = best.candidates.findIndex(c => samePosition(c.pos, positionEnd));
  if(playedIndex < 0) playedIndex = 0;

  // PositionI / Cube.Position are always treated as the canonical board.
  // PositionEnd uses XG's active-player orientation for player -1, so the
  // replay board is rebuilt from the actual move sequence instead of trusting
  // the raw end-position orientation.
  const beforePosition = normalizeStoredPosition(positionI);
  const applied = applyCheckerMove(beforePosition, activePlayer, moveRaw);
  const expectedEnd = normalizeMoveEndPosition(positionEnd, activePlayer);
  const move = formatCheckerMove(moveRaw, beforePosition, activePlayer);

  const isDance = !applied.segments.length;
  for(const candidate of best.candidates){
    if(isDance && samePosition(candidate.pos, positionEnd)){
      candidate.move = 'Cannot Move';
    }else{
      candidate.move = formatCheckerMove(candidate.moveRaw, beforePosition, activePlayer);
    }
  }

  return {
    positionI,positionEnd,activePlayer,moveRaw,move,dice,cubeCode,best,playedIndex,
    errMove,errLuck,initEq,invalidM,beforePosition,afterPosition:applied.position,appliedSegments:applied.segments,expectedEnd
  };
}

function parseCube(rec){
  const activePlayer = int32(rec,12);
  const doubleAction = int32(rec,16);
  const take = int32(rec,20);
  const beaver = int32(rec,24);
  const raccoon = int32(rec,28);
  const cubeCode = int32(rec,32);
  const position = readPosition(rec,36);
  const analysis = parseDoubleEngine(rec,64);
  const errCube = float64(rec,200);
  const errTake = float64(rec,216);
  const isValid = int32(rec,260);
  return {activePlayer,doubleAction,take,beaver,raccoon,cubeCode,position,analysis,errCube,errTake,isValid};
}

function parseFooterGame(rec){
  return {
    score1:int32(rec,12),
    score2:int32(rec,16),
    crawfordNext:uint8(rec,20)!==0,
    winner:int32(rec,24),
    pointsWon:int32(rec,28),
    termination:int32(rec,32)
  };
}

function parseGameRecords(gameBuf){
  if(gameBuf.length % RECORD_SIZE !== 0) throw new Error('Unexpected temp.xg record length');
  const records = [];
  let version = -1;
  let match = null;
  for(let off=0, index=0; off<gameBuf.length; off+=RECORD_SIZE,index++){
    const rec = gameBuf.subarray(off, off + RECORD_SIZE);
    const type = uint8(rec,8);
    if(type === 0){
      const data = parseHeaderMatch(rec);
      version = data.version;
      match = data;
      records.push({type:'matchHeader', index, ...data});
    }else if(type === 1){
      records.push({type:'gameHeader', index, ...parseGameHeader(rec,version)});
    }else if(type === 2){
      records.push({type:'cube', index, ...parseCube(rec)});
    }else if(type === 3){
      records.push({type:'move', index, ...parseMove(rec,version)});
    }else if(type === 4){
      records.push({type:'gameFooter', index, ...parseFooterGame(rec)});
    }else if(type === 5){
      records.push({type:'matchFooter', index, score1:int32(rec,12), score2:int32(rec,16), winner:int32(rec,20)});
    }
  }
  if(!match) throw new Error('Match header not found');
  return {match, records};
}

function stateWinRate(activePlayer, activeRate, fallbackBlack){
  const b = blackRateFromActive(activePlayer, activeRate);
  const black = Number.isFinite(b) ? clampRate(b) : clampRate(fallbackBlack ?? 50);
  return {black, white:100-black};
}

function stateGammonRate(activePlayer, activeGammonRate, opponentGammonRate, fallback={black:0,white:0}){
  const active=Number(activeGammonRate),opponent=Number(opponentGammonRate);
  if(!Number.isFinite(active)||!Number.isFinite(opponent)){
    return {black:clampRate(fallback?.black??0),white:clampRate(fallback?.white??0)};
  }
  return activePlayer===1
    ? {black:clampRate(active),white:clampRate(opponent)}
    : {black:clampRate(opponent),white:clampRate(active)};
}
function gammonRateFromResult(activePlayer,result,fallback){
  if(!Array.isArray(result)||result.length<5) return stateGammonRate(activePlayer,NaN,NaN,fallback);
  // XG TResult: [lose BG, lose G, lose total, win total, win G, win BG, equity].
  // win G / lose G already include backgammon outcomes, so use indices 4 / 1 directly.
  return stateGammonRate(activePlayer,Number(result[4])*100,Number(result[1])*100,fallback);
}
function stateBackgammonRate(activePlayer, activeBackgammonRate, opponentBackgammonRate, fallback={black:0,white:0}){
  const active=Number(activeBackgammonRate),opponent=Number(opponentBackgammonRate);
  if(!Number.isFinite(active)||!Number.isFinite(opponent)){
    return {black:clampRate(fallback?.black??0),white:clampRate(fallback?.white??0)};
  }
  return activePlayer===1
    ? {black:clampRate(active),white:clampRate(opponent)}
    : {black:clampRate(opponent),white:clampRate(active)};
}
function backgammonRateFromResult(activePlayer,result,fallback){
  if(!Array.isArray(result)||result.length<6) return stateBackgammonRate(activePlayer,NaN,NaN,fallback);
  // XG TResult: index 5 = active player's BG win rate, index 0 = opponent's BG win rate.
  return stateBackgammonRate(activePlayer,Number(result[5])*100,Number(result[0])*100,fallback);
}

function buildTimeline(parsed, sourceFile){
  const states = [];
  let gameNumber = 0;
  let score = [0,0];
  let lastBlackRate = 50;
  let lastGammonRate = {black:0,white:0};
  let lastBackgammonRate = {black:0,white:0};
  let lastPosition = null;
  let lastCube = {value:1,owner:0};
  let gameHasCheckerMove = false;
  let matchIntroPushed = false;
  const prStats = {
    black:{error:0,decisions:0},
    white:{error:0,decisions:0}
  };
  const validDecisionError = value => Number.isFinite(Number(value)) && Math.abs(Number(value)) < 999;
  const playerKey = activePlayer => activePlayer === 1 ? 'black' : 'white';
  const snapshotPR = () => ({
    black:prStats.black.decisions ? prStats.black.error / prStats.black.decisions * 500 : 0,
    white:prStats.white.decisions ? prStats.white.error / prStats.white.decisions * 500 : 0,
    decisions:{black:prStats.black.decisions,white:prStats.white.decisions}
  });
  const addPrDecision = (activePlayer,error,counts=true) => {
    if(!counts || !validDecisionError(error)) return;
    const key=playerKey(activePlayer);
    prStats[key].error += Math.abs(Number(error));
    prStats[key].decisions += 1;
  };
  const cubeOfferCounts = r => {
    if(r.isValid && r.isValid !== 0) return false;
    if(!validDecisionError(r.errCube)) return false;
    const nd=Number(r.analysis?.equityNoDouble),dt=Number(r.analysis?.equityDoubleTake),dp=Number(r.analysis?.equityDrop);
    if(![nd,dt,dp].every(Number.isFinite)) return false;
    const doubled=Math.min(dt,dp);
    if(Math.abs(nd-doubled)<0.001) return false;
    if(nd-doubled>=0.200) return false;
    return true;
  };
  const takePassCounts = r => {
    if(r.isValid && r.isValid !== 0) return false;
    if(!validDecisionError(r.errTake)) return false;
    const dt=Number(r.analysis?.equityDoubleTake),dp=Number(r.analysis?.equityDrop);
    return Number.isFinite(dt)&&Number.isFinite(dp)&&Math.abs(dt-dp)>=0.001;
  };
  const pushState = state => states.push({...state,backgammonRate:state.backgammonRate??{...lastBackgammonRate},pr:snapshotPR()});

  const recs = parsed.records;
  for(let i=0;i<recs.length;i++){
    const r = recs[i];
    if(r.type === 'gameHeader'){
      gameNumber = r.gameNumber;
      score = [r.score1,r.score2];
      lastPosition = normalizeStoredPosition(r.pos);
      lastCube = {value: 2 ** Math.max(0,r.autoDoubles || 0), owner:0};
      lastBlackRate = 50;
      lastGammonRate = {black:0,white:0};
      lastBackgammonRate = {black:0,white:0};
      gameHasCheckerMove = false;
      if(!matchIntroPushed){
        matchIntroPushed = true;
        pushState({
          phase:'matchStart', gameNumber, score:[...score], activePlayer:0,
          position:lastPosition, dice:null, cube:lastCube,
          winRate:{black:lastBlackRate,white:100-lastBlackRate},
          gammonRate:{...lastGammonRate},
          analysis:{type:'none'}, historyEvent:null
        });
      }
      pushState({
        phase:'gameStart', gameNumber, score:[...score], activePlayer:0,
        position:lastPosition, dice:null, cube:lastCube,
        winRate:{black:lastBlackRate,white:100-lastBlackRate},
        gammonRate:{...lastGammonRate},
        analysis:{type:'none'}, historyEvent:null
      });
      continue;
    }

    if(r.type === 'cube'){
      const position = normalizeStoredPosition(r.position);
      const activeRate = r.analysis && r.analysis.result ? r.analysis.result[3] * 100 : null;
      let winRate = stateWinRate(r.activePlayer, activeRate, lastBlackRate);
      let gammonRate = gammonRateFromResult(r.activePlayer,r.analysis?.result,lastGammonRate);
      let backgammonRate = backgammonRateFromResult(r.activePlayer,r.analysis?.result,lastBackgammonRate);
      if(r.analysis.result.every(v => v === 0)){
        winRate = {black:lastBlackRate,white:100-lastBlackRate};
        gammonRate = {...lastGammonRate};
        backgammonRate = {...lastBackgammonRate};
      }
      const cube = {value:cubeValueFromCode(r.cubeCode),owner:cubeOwnerFromCode(r.cubeCode)};

      if(r.doubleAction === 1){
        const doubler=r.activePlayer===1?'black':'white';
        const responder=doubler==='black'?'white':'black';
        const responderActive=-r.activePlayer;
        const offeredValue=Math.max(2,(Number(cube.value)||1)*2);
        const pairId=`cube-${gameNumber}-${r.index}`;

        const nd=Number(r.analysis.equityNoDouble);
        const dt=Number(r.analysis.equityDoubleTake);
        const dp=Number(r.analysis.equityDrop);
        const doubledEq=Math.min(dt,dp);
        const offerBest=Math.max(nd,doubledEq);
        const offerCandidates=[
          {move:'Double',equity:doubledEq,error:doubledEq-offerBest},
          {move:'No Double',equity:nd,error:nd-offerBest}
        ];

        // Doubleした場合も、まず候補を未選択で表示し、その次に実際のDoubleを選択する。
        pushState({
          phase:'cubeOffer',gameNumber,score:[...score],activePlayer:r.activePlayer,
          position,dice:null,cube,winRate,gammonRate,backgammonRate,
          analysis:{type:'moves',candidates:offerCandidates},historyEvent:null
        });
        addPrDecision(r.activePlayer,r.errCube,cubeOfferCounts(r));
        pushState({
          phase:'cubeOfferSelect',gameNumber,score:[...score],activePlayer:r.activePlayer,
          position,dice:null,cube,winRate,gammonRate,backgammonRate,
          analysis:{type:'moves',candidates:offerCandidates,playedIndex:0},
          historyEvent:{player:doubler,dice:null,move:'Double',error:-Math.abs(Number(r.errCube)||0),kind:'cube',cubeValue:offeredValue,pairId}
        });

        // Take / Pass candidates are shown once without a selection, then the actual response is selected.
        const responseBest=Math.min(dt,dp);
        const responseCandidates=[
          {move:'Take',equity:dt,error:-(dt-responseBest)},
          {move:'Pass',equity:dp,error:-(dp-responseBest)}
        ];
        pushState({
          phase:'cubeResponse',gameNumber,score:[...score],activePlayer:responderActive,
          position,dice:null,cube,winRate,gammonRate,backgammonRate,
          analysis:{type:'moves',candidates:responseCandidates},historyEvent:null
        });

        const responseIndex=r.take===1||r.take===2?0:1;
        const responseMove=responseIndex===0?'Take':'Pass';
        const cubeAfter=responseMove==='Take'?{value:offeredValue,owner:responder}:cube;
        addPrDecision(responderActive,r.errTake,takePassCounts(r));
        pushState({
          phase:'cubeResponseSelect',gameNumber,score:[...score],activePlayer:responderActive,
          position,dice:null,cube:cubeAfter,winRate,gammonRate,backgammonRate,
          analysis:{type:'moves',candidates:responseCandidates,playedIndex:responseIndex},
          historyEvent:{player:responder,dice:null,move:responseMove,error:-Math.abs(Number(r.errTake)||0),kind:'cubeResponse',cubeValue:offeredValue,pairId}
        });
        lastCube=cubeAfter;
      }else{
        const nd=Number(r.analysis.equityNoDouble);
        const dt=Number(r.analysis.equityDoubleTake);
        const dp=Number(r.analysis.equityDrop);
        const doubledEq=Math.min(dt,dp);
        const offerBest=Math.max(nd,doubledEq);
        const offerCandidates=[
          {move:'Double',equity:doubledEq,error:doubledEq-offerBest},
          {move:'No Double',equity:nd,error:nd-offerBest}
        ];
        const missedDouble=Number.isFinite(nd)&&Number.isFinite(doubledEq)&&doubledEq>nd+0.000001;

        // 最善手がDoubleなのにNo Doubleを選んだ場合は、ロール前にキューブ判断を2段階表示する。
        if(missedDouble){
          const player=r.activePlayer===1?'black':'white';
          const offeredValue=Math.max(2,(Number(cube.value)||1)*2);
          const pairId=`cube-nd-${gameNumber}-${r.index}`;
          pushState({
            phase:'cubeOffer',gameNumber,score:[...score],activePlayer:r.activePlayer,
            position,dice:null,cube,winRate,gammonRate,backgammonRate,
            analysis:{type:'moves',candidates:offerCandidates},historyEvent:null
          });
          addPrDecision(r.activePlayer,r.errCube,cubeOfferCounts(r));
          const noDoubleError=-Math.abs(Number(r.errCube)||Math.max(0,doubledEq-nd));
          const isHistoryError=Math.abs(noDoubleError)>=0.020;
          pushState({
            phase:'cubeOfferSelect',gameNumber,score:[...score],activePlayer:r.activePlayer,
            position,dice:null,cube,winRate,gammonRate,backgammonRate,
            analysis:{type:'moves',candidates:offerCandidates,playedIndex:1},
            historyEvent:isHistoryError?{player,dice:null,move:'No Double',error:noDoubleError,kind:'cube',cubeValue:offeredValue,pairId}:null
          });
        }else{
          // 通常のNo Double判断は従来どおり表示せず、PRのみ選択時点として反映する。
          addPrDecision(r.activePlayer,r.errCube,cubeOfferCounts(r));
        }

        // Pre-roll state: evaluate all 21 distinct rolls from the current board.
        // The actually rolled dice are intentionally not used to decide which rolls are highlighted.
        // 各ゲーム初手だけは opening roll 自体を手番開始シーケンスにするため、
        // 初手直前の No Double 解析レコードから preRoll を生成しない。
        if(gameHasCheckerMove){
          const rollAnalysis=analyzeJokerRolls(position,r.activePlayer,{winRate,gammonRate,backgammonRate});
          pushState({
            phase:'preRoll',gameNumber,score:[...score],activePlayer:r.activePlayer,
            position,dice:null,cube,winRate,gammonRate,backgammonRate,
            analysis:{type:'jokers',...rollAnalysis},historyEvent:null
          });
        }
        lastCube = cube;
      }
      lastPosition = position;
      lastBlackRate = winRate.black;
      lastGammonRate = {...gammonRate};
      lastBackgammonRate = {...backgammonRate};
      continue;
    }

    if(r.type === 'move'){
      const played = r.best.candidates[r.playedIndex] || r.best.candidates[0] || null;
      const best = r.best.candidates[0] || played || null;
      const selectedWinRate = stateWinRate(r.activePlayer,played ? played.winRate : null,lastBlackRate);
      const bestWinRate = stateWinRate(r.activePlayer,best ? best.winRate : null,lastBlackRate);
      const selectedGammonRate = played
        ? stateGammonRate(r.activePlayer,played.gammonRate,played.opponentGammonRate,lastGammonRate)
        : {...lastGammonRate};
      const bestGammonRate = best
        ? stateGammonRate(r.activePlayer,best.gammonRate,best.opponentGammonRate,lastGammonRate)
        : {...lastGammonRate};
      const selectedBackgammonRate = played
        ? stateBackgammonRate(r.activePlayer,played.backgammonRate,played.opponentBackgammonRate,lastBackgammonRate)
        : {...lastBackgammonRate};
      const bestBackgammonRate = best
        ? stateBackgammonRate(r.activePlayer,best.backgammonRate,best.opponentBackgammonRate,lastBackgammonRate)
        : {...lastBackgammonRate};
      const beforePosition = r.beforePosition || normalizeStoredPosition(r.positionI);
      const afterPosition = r.afterPosition || applyCheckerMove(beforePosition,r.activePlayer,r.moveRaw).position;
      const candidates = r.best.candidates.map(c => ({
        move:c.move,
        equity:c.equity,
        error:c.equity - (r.best.candidates[0]?.equity ?? c.equity),
        winRate:c.winRate,
        gammonRate:c.gammonRate,
        opponentGammonRate:c.opponentGammonRate,
        backgammonRate:c.backgammonRate,
        opponentBackgammonRate:c.opponentBackgammonRate,
        // 候補手ごとのムーブ後盤面もJSONへ保持し、配信側だけで完結させる。
        position:applyCheckerMove(beforePosition,r.activePlayer,c.moveRaw).position
      }));
      // 選択手では、候補側の推定盤面ではなく棋譜に実際に適用した盤面を表示する。
      const selectedPosition = afterPosition;
      const cube = {value:cubeValueFromCode(r.cubeCode),owner:cubeOwnerFromCode(r.cubeCode)};
      const diceMuted = r.move === 'Cannot Move' || r.move === 'Dance' || !(Array.isArray(r.appliedSegments) && r.appliedSegments.length);

      // 通常手は4段階で表示する。
      // 1) 手番交代 + Joker / Anti-Joker候補
      // 2) ロールのみ表示（候補手はまだ出さない）+ 最善手の勝率へバー推移
      // 3) 候補手表示（勝率バーはそのまま）
      // 4) 選択手を金表示 + チェッカー移動 + 選択手の勝率
      // 各ゲームの初手だけは、手番開始とロールを同一シーケンスにする。
      // オープニングロールには事前Joker/Anti-Joker候補を出さない。
      const isOpeningMove=!gameHasCheckerMove;
      let previous = states[states.length - 1];
      if(!isOpeningMove){
        if(previous && previous.phase === 'preRoll' && previous.gameNumber === gameNumber && previous.activePlayer === r.activePlayer){
          // 既存のpreRollは盤面予測そのものを維持する。
          // 直後に実際に出た目のerrLuckで候補を上書きしない。
        }else{
          const rollAnalysis=analyzeJokerRolls(beforePosition,r.activePlayer,{winRate:{black:lastBlackRate,white:100-lastBlackRate},gammonRate:lastGammonRate,backgammonRate:lastBackgammonRate});
          pushState({
            phase:'preRoll',gameNumber,score:[...score],activePlayer:r.activePlayer,
            position:beforePosition,dice:null,cube,winRate:{black:lastBlackRate,white:100-lastBlackRate},
            gammonRate:{...lastGammonRate},backgammonRate:{...lastBackgammonRate},
            analysis:{type:'jokers',...rollAnalysis},historyEvent:null
          });
          previous=states[states.length-1];
        }
      }
      // ロール後の光り方も、事前の盤面予測と同じ判定を使用する。
      const luckKind=isOpeningMove?null:classifyRollLuck(previous?.analysis,r.dice);
      const preRollBlackRate=Number(lastBlackRate);
      const preRollWhiteRate=100-preRollBlackRate;
      const postRollBlackRate=Number(bestWinRate.black);
      const postRollWhiteRate=Number(bestWinRate.white);
      const rollSwing=Math.abs(postRollBlackRate-preRollBlackRate);
      // 大逆転: 同じ選手の勝率が1ロールで30%以下から70%以上へ逆転したとき。
      const blackComeback=Number.isFinite(preRollBlackRate) && Number.isFinite(postRollBlackRate) && preRollBlackRate<=30 && postRollBlackRate>=70;
      const whiteComeback=Number.isFinite(preRollWhiteRate) && Number.isFinite(postRollWhiteRate) && preRollWhiteRate<=30 && postRollWhiteRate>=70;
      const isBigComeback=blackComeback||whiteComeback;
      // ナイスロール: 1ロールで勝率が20pt以上動く。大逆転条件を満たす場合は大逆転を優先。
      const isNiceRoll=Number.isFinite(rollSwing) && rollSwing>=20 && !isBigComeback;
      const rollNotice=isBigComeback?'comeback':(isNiceRoll?'nice':null);

      if(isBigComeback){
        const introAnalysis=isOpeningMove
          ? {type:'jokers',joker:[],antiJoker:[],openingRoll:true}
          : (previous?.analysis?.type==='jokers' ? previous.analysis : {type:'jokers',...analyzeJokerRolls(beforePosition,r.activePlayer,{winRate:{black:lastBlackRate,white:100-lastBlackRate},gammonRate:lastGammonRate,backgammonRate:lastBackgammonRate})});
        pushState({
          phase:'bigComebackIntro',gameNumber,score:[...score],activePlayer:r.activePlayer,
          position:beforePosition,dice:null,cube,
          winRate:{black:lastBlackRate,white:100-lastBlackRate},gammonRate:{...lastGammonRate},backgammonRate:{...lastBackgammonRate},luckKind:null,diceMuted,
          analysis:introAnalysis,historyEvent:null,
          bigComeback:true,rollNotice:'comeback'
        });
      }

      const cannotMove = r.move === 'Cannot Move' || r.move === 'Dance';
      if(cannotMove){
        // Cannot Move はロール表示と候補選択を同一シーケンスにする。
        // ロールが出た瞬間に選択済み候補・履歴・PRまで同時に反映する。
        addPrDecision(r.activePlayer,r.errMove,r.invalidM===0 && r.best.unused!==1);
        pushState({
          phase:'roll',gameNumber,score:[...score],activePlayer:r.activePlayer,
          position:selectedPosition,dice:r.dice,cube,
          winRate:selectedWinRate,gammonRate:selectedGammonRate,backgammonRate:selectedBackgammonRate,luckKind,diceMuted,
          analysis:{type:'moves',candidates,playedIndex:r.playedIndex},
          moveAnimation:{beforePosition,segments:r.appliedSegments||[]},
          historyEvent:{player:r.activePlayer===1?'black':'white',dice:r.dice,move:r.move,error:r.errMove,kind:'move'},
          forcedMove:true,bigComeback:isBigComeback,rollNotice
        });
      }else{
        pushState({
          phase:'roll',gameNumber,score:[...score],activePlayer:r.activePlayer,
          position:beforePosition,dice:r.dice,cube,
          winRate:bestWinRate,gammonRate:bestGammonRate,backgammonRate:bestBackgammonRate,luckKind,diceMuted,
          analysis:isOpeningMove?{type:'jokers',joker:[],antiJoker:[],openingRoll:true}:{type:'none'},historyEvent:null,
          bigComeback:isBigComeback,rollNotice
        });
        const candidateEquities=candidates.map(c=>Number(c.equity)).filter(Number.isFinite);
        const allCandidateEquitiesSame=candidates.length>1 && candidateEquities.length===candidates.length &&
          (Math.max(...candidateEquities)-Math.min(...candidateEquities)<=1e-6);
        const allCandidatesWithin001=candidates.length>1 && candidateEquities.length===candidates.length &&
          (Math.max(...candidateEquities)-Math.min(...candidateEquities)<=0.0100001);
        const sameEquityBearoff=allInHome(beforePosition,r.activePlayer) && allCandidateEquitiesSame;
        const forcedMove = candidates.length <= 1 || diceMuted || sameEquityBearoff || allCandidatesWithin001;
        if(forcedMove){
          // 全候補の評価値差が0.01以内なら候補一覧を省略し、実際の選択手をそのまま確定する。
          // 従来のフォーストムーブ等は表示仕様を維持する。
          addPrDecision(r.activePlayer,r.errMove,r.invalidM===0 && r.best.unused!==1);
          pushState({
            phase:'candidates',gameNumber,score:[...score],activePlayer:r.activePlayer,
            position:selectedPosition,dice:r.dice,cube,winRate:selectedWinRate,gammonRate:selectedGammonRate,backgammonRate:selectedBackgammonRate,luckKind,diceMuted,
            analysis:allCandidatesWithin001?{type:'none'}:{type:'moves',candidates,playedIndex:r.playedIndex},
            moveAnimation:{beforePosition,segments:r.appliedSegments||[]},
            historyEvent:{player:r.activePlayer===1?'black':'white',dice:r.dice,move:r.move,error:r.errMove,kind:'move'},
            forcedMove:true,autoSelectedNearEqual:allCandidatesWithin001
          });
        }else{
        pushState({
          phase:'candidates',gameNumber,score:[...score],activePlayer:r.activePlayer,
          position:beforePosition,dice:r.dice,cube,winRate:bestWinRate,gammonRate:bestGammonRate,backgammonRate:bestBackgammonRate,luckKind,diceMuted,
          analysis:{type:'moves',candidates},historyEvent:null
        });
        // 通常手は候補表示ではPRを変えず、実際の手を選択した瞬間に反映する。
        addPrDecision(r.activePlayer,r.errMove,r.invalidM===0 && r.best.unused!==1);
        pushState({
          phase:'analysis',gameNumber,score:[...score],activePlayer:r.activePlayer,
          position:selectedPosition,dice:r.dice,cube,winRate:selectedWinRate,gammonRate:selectedGammonRate,backgammonRate:selectedBackgammonRate,luckKind,diceMuted,
          analysis:{type:'moves',candidates,playedIndex:r.playedIndex},
          // 配信側でムーブ前→ムーブ後を順番に0.5秒ずつアニメーションするため、
          // 実棋譜の移動区間をそのまま保持する。外部ファイル参照は不要。
          moveAnimation:{beforePosition,segments:r.appliedSegments||[]},
          historyEvent:{player:r.activePlayer===1?'black':'white',dice:r.dice,move:r.move,error:r.errMove,kind:'move'}
        });
        }
      }
      gameHasCheckerMove = true;
      lastPosition = afterPosition;
      lastCube = cube;
      lastBlackRate = selectedWinRate.black;
      lastGammonRate = {...selectedGammonRate};
      lastBackgammonRate = {...selectedBackgammonRate};
      continue;
    }

    if(r.type === 'gameFooter'){
      const beforeScore=[...score];
      const afterScore=[r.score1,r.score2];
      const winner=r.winner===1?'black':(r.winner===-1?'white':null);
      const points=Math.max(0,Number(r.pointsWon)||0);
      pushState({
        phase:'gameEnd',gameNumber,score:[...beforeScore],activePlayer:0,
        position:lastPosition,dice:null,cube:lastCube,
        winRate:{black:lastBlackRate,white:100-lastBlackRate},gammonRate:{...lastGammonRate},analysis:{type:'none'},historyEvent:null,
        scoreDelta:winner&&points?{winner,points}:null
      });
      score=afterScore;
      pushState({
        phase:'scoreUpdate',gameNumber,score:[...score],activePlayer:0,
        position:lastPosition,dice:null,cube:lastCube,
        winRate:{black:lastBlackRate,white:100-lastBlackRate},gammonRate:{...lastGammonRate},analysis:{type:'none'},historyEvent:null
      });
      const matchLength=Math.max(0,Number(parsed.match?.matchLength)||0);
      const matchFinished=matchLength>0 && (afterScore[0]>=matchLength || afterScore[1]>=matchLength);
      if(matchFinished){
        const matchWinner=afterScore[0]>=matchLength?'black':'white';
        pushState({
          phase:'matchEnd',gameNumber,score:[...score],activePlayer:0,
          position:lastPosition,dice:null,cube:lastCube,
          winRate:{black:lastBlackRate,white:100-lastBlackRate},gammonRate:{...lastGammonRate},analysis:{type:'none'},historyEvent:null,
          matchWinner
        });
      }
    }
  }

  return {
    schemaVersion:17,
    sourceFile,
    generatedAt:new Date().toISOString(),
    match:{...parsed.match, blackSourcePlayer:parsed.match.player1, whiteSourcePlayer:parsed.match.player2},
    states
  };
}

function parseXgBuffer(raw, sourceFile='match.xg'){
  const arc = extractArchive(raw);
  const game = arc.files['temp.xg'];
  if(!game) throw new Error('temp.xg not found in XG archive');
  const parsed = parseGameRecords(game);
  return buildTimeline(parsed,sourceFile);
}

function parseXgFile(filename){
  return parseXgBuffer(fs.readFileSync(filename), path.basename(filename));
}

module.exports = {parseXgBuffer,parseXgFile,JOKER_WINRATE_THRESHOLD,JOKER_EQUITY_THRESHOLD};
