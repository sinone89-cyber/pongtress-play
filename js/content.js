'use strict';
/* PONGTRESS 콘텐츠·수치 데이터 (프로토타입 슬라이스)
 * 밸런스 수치는 여기 한곳. game.js 보다 먼저 로드된다.
 */
const CFG = {
  lanes: 3,
  fieldRows: 5,            // 적 대기 필드 세로 칸 수(레인당)
  launchesPerTurn: 2,      // 한 장전 턴에 쏘는 볼 수(기본). 패시브로 증가 예정
  maxBalls: 60,            // 볼 폭주 방지 상한
  gravity: 1200,           // px/s^2 (핀볼 영역 기준)
  restitution: 0.68,
  wallRestitution: 0.72,
  ballRadius: 7,
  pegRadius: 9,
  powerMin: 980,           // 플런저 최소 강도(위로 충분히 뜨게)
  powerMax: 1650,          // 최대(홀드 만충)
  powerChargeTime: 900,    // ms, 홀드 만충까지
  launchVx: 0.22,          // 발사 수평 성분 비율(위로 쏘되 살짝 왼쪽)
  battleShotDelay: 240,    // ms, 전투 phase 공격 1발 간 간격(보이게 느리게)
  battleStartDelay: 500,   // ms, 전투 phase 시작 후 첫 공격까지
  battleEndDelay: 800,     // ms, 마지막 공격 후 적 전진까지
  enemyContactFlash: 250
};

// 레벨업에 필요한 누적 경험치: 레벨 L→L+1
function expToNext(level) { return 8 + level * 5; }

// ── 캐릭터 (프로토타입: 처음부터 3명 배치. 편성/가챠는 다음 패스) ──
// atk 공격력(발당 피해) · hp 체력(성벽 HP에 합산) · gol 고정 골칸 수(레인 3칸 중 충전 칸)
// active 액티브 스킬(게이지 N) · passive 패시브(보드 효과, 이번 패스 일부만 구현)
const ROSTER = [
  { id: 'knight', name: '검사', atk: 8, hp: 34, gol: 1,
    active: { name: '강타', gauge: 12, kind: 'bigHit', mult: 3 },   // 맨 앞 적에게 atk*3
    passive: { name: '예광', kind: 'addPeg', peg: 'mult2', n: 1 } },
  { id: 'archer', name: '궁수', atk: 5, hp: 20, gol: 2,
    active: { name: '연사', gauge: 15, kind: 'extraShots', shots: 4 }, // 이번 턴 추가 4발
    passive: { name: '보급', kind: 'addBall', n: 1 } },               // 시작 볼 +1
  { id: 'guard', name: '방패병', atk: 3, hp: 52, gol: 3,
    active: { name: '방벽', gauge: 18, kind: 'heal', amount: 24 },     // 성벽 HP 회복
    passive: { name: '정리', kind: 'closeBlank', n: 1 } }             // 시작 시 꽝 1칸 닫힘(→충전)
];

// ── 적 ──
const ENEMIES = {
  goblin: { name: '고블린', hp: 12, dmg: 7, exp: 4, color: '#7ac74f' },
  bat:    { name: '박쥐',   hp: 7,  dmg: 5, exp: 3, color: '#9b6cff' },
  orc:    { name: '오크',   hp: 26, dmg: 13, exp: 9, color: '#e0733a' }
};

// ── 보스: 거대 골렘(돌진형) ──
const BOSS_GOLEM = {
  name: '거대 골렘', hp: 240, dmg: 34, exp: 80, color: '#8a8f9a',
  thresholds: [0.75, 0.5, 0.25],   // 이 비율 이하로 처음 내려갈 때마다 후퇴+스턴
  retreat: 2, stunTurns: 1, vulnerable: 0.5   // 스턴 중 받는 피해 +50%
};

// ── 전투(웨이브) 구성: 런 = 3 일반전투 + 보스 ──
// 각 전투는 적을 순차 스폰. spawn[i] = 이 턴에 상단에 등장시킬 적 목록(레인은 자동 분배)
const COMBATS = [
  { name: '전투 1', waves: [['goblin','goblin'], ['goblin'], ['bat','goblin'], ['bat']] },
  { name: '전투 2', waves: [['goblin','bat','goblin'], ['orc'], ['bat','bat'], ['goblin','orc']] },
  { name: '전투 3', waves: [['orc','goblin'], ['bat','bat','bat'], ['orc','orc'], ['goblin','goblin','bat']] },
  { name: '보스 · 거대 골렘', boss: true }
];

// ── 레벨업 보상 후보(3택1) ──
const REWARDS = [
  { id: 'heal',   name: '수리',      desc: '성벽 HP +25', apply: (S) => { S.wallHp = Math.min(S.wallHpMax, S.wallHp + 25); } },
  { id: 'atk',    name: '연마',      desc: '모든 캐릭터 공격력 +1 (이번 런)', apply: (S) => { S.atkBonus += 1; } },
  { id: 'open',   name: '골칸 개방', desc: '꽝 포켓 1칸을 충전 칸으로', apply: (S) => { openOneBlank(S); } },
  { id: 'ball',   name: '증설',      desc: '이번 런 장전 볼 +1', apply: (S) => { S.bonusBalls += 1; } },
  { id: 'mult',   name: '증식판',    desc: '핀볼판에 ×2 페그 추가', apply: (S) => { addPegToBoard(S, 'mult2', 2); } }
];

// ── 전역 헬퍼(보상·패시브에서 사용) ──
function openOneBlank(S) {
  const lanesWithChar = new Set(S.chars.map(c => c.lane));
  const cand = S.pockets.filter(p => p.type === 'blank' && lanesWithChar.has(p.lane));
  if (cand.length) cand[0].type = 'charge';
}
function addPegToBoard(S, type, n) {
  for (let i = 0; i < n; i++) {
    S.pegs.push({ fx: 0.12 + Math.random() * 0.76, fy: 0.15 + Math.random() * 0.6, type, alive: true });
  }
}
