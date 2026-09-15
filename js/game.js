'use strict';
/* PONGTRESS 프로토타입 0.2 — 전투 코어 슬라이스
 * content.js(CFG·ROSTER·ENEMIES·BOSS_GOLEM·COMBATS·REWARDS·expToNext) 이후 로드.
 * 한 턴 = 장전 phase(플런저로 볼을 쏘아 배수 페그로 불리고 9칸 골 포켓에 떨어뜨려 캐릭터 탄환 충전)
 *        → 전투 phase(충전된 캐릭터가 맨 앞 적 자동 공격, EXP·레벨업·보상, 적 전진).
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const boot = (m) => { const b = $('boot-error'); if (b) { b.hidden = false; b.textContent = 'ERROR: ' + m; } };
  window.addEventListener('error', (e) => boot(e.message + ' @' + (e.lineno || '?')));

  const canvas = $('stage'); const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1;

  // ── 전역 상태 ──
  let S = null;          // 런/전투 상태
  let anim = { floats: [], flashes: [] };
  let aimActive = false, aimX = 0, aimY = 0;
  let lastTs = 0;

  // ============ 화면 전환 ============
  function show(name) {
    for (const s of ['title', 'lobby', 'combat']) $(s).hidden = (s !== name);
  }

  // ============ 레이아웃(phase별 영역 비율) ============
  // 위→아래: 적 필드 / 성벽(캐릭터) / 골 포켓(성벽 바로 아래) / 핀볼 필드(하단 중앙에서 위로 발사)
  function layout() {
    const load = !S || S.phase === 'load';
    const f = load ? { field: .16, wall: .10, goal: .09, pins: .65 }
                   : { field: .50, wall: .12, goal: .08, pins: .30 };
    let y = 0; const r = {};
    r.field = { x: 0, y, w: W, h: H * f.field }; y += r.field.h;
    r.wall = { x: 0, y, w: W, h: H * f.wall }; y += r.wall.h;
    r.goal = { x: 0, y, w: W, h: H * f.goal }; y += r.goal.h;
    r.pins = { x: 0, y, w: W, h: H * f.pins };
    return r;
  }
  // 발사대 위치(핀볼 영역 하단 중앙)
  function launcher() { const p = layout().pins; return { x: p.x + p.w / 2, y: p.y + p.h - CFG.ballRadius - 4 }; }

  function resize() {
    const rect = $('stage-wrap').getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(240, Math.floor(rect.width));
    H = Math.max(360, Math.floor(rect.height));
    canvas.width = Math.floor(W * dpr); canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ============ 런 시작 ============
  function startRun() {
    const party = ROSTER.map(c => c.id);            // 프로토타입: 기본 3인
    const wallMax = party.reduce((s, id) => s + roster(id).hp, 0);
    S = {
      combatIndex: 0, level: 1, exp: 0, expNext: expToNext(1),
      atkBonus: 0, bonusBalls: 0, party,
      wallHpMax: wallMax, wallHp: wallMax,
      // 아래는 전투마다 초기화
      phase: 'load', chars: [], pegs: [], pockets: [], balls: [],
      enemies: [], waves: [], waveIdx: 0, launchesLeft: 0, passiveBalls: 0,
      shotQueue: [], battleTimer: 0, pendingRewards: 0, autoSkill: false,
      combat: null, over: false
    };
    show('combat'); resize();
    startCombat(0);
    requestAnimationFrame(loop);
  }

  const roster = (id) => ROSTER.find(c => c.id === id);

  // ============ 전투 시작 ============
  function startCombat(idx) {
    S.combatIndex = idx;
    const combat = COMBATS[idx];
    S.combat = combat; S.over = false;
    // 캐릭터(레인 배치) — 프로토타입: party 순서대로 레인 0,1,2
    S.chars = S.party.map((id, lane) => ({ ref: roster(id), lane, ammo: 0, gauge: 0, armed: false }));
    S.passiveBalls = 0;
    S.balls = []; S.shotQueue = []; anim.floats = []; anim.flashes = [];
    buildBoard();
    // 패시브(보드 효과) 적용
    for (const c of S.chars) applyPassive(c.ref.passive);
    // 적/웨이브
    S.enemies = [];
    if (combat.boss) { spawnBoss(); S.waves = []; }
    else { S.waves = combat.waves.slice(); spawnWave(); }
    S.waveIdx = 0;
    $('c-name').textContent = combat.name;
    enterLoad();
    syncHud();
  }

  // ============ 보드(페그·포켓) 생성 ============
  function buildBoard() {
    S.pegs = [];
    // 페그: 격자 + 지터, 일부 배수 페그
    const cols = 6, rows = 5;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const off = (r % 2) ? 0.5 / cols : 0;
        const fx = (c + 0.5) / cols + off + (Math.random() - 0.5) * 0.04;
        const fy = 0.14 + r * (0.7 / (rows - 1)) + (Math.random() - 0.5) * 0.03;
        if (fx < 0.05 || fx > 0.95) continue;
        let type = 'normal';
        const rnd = Math.random();
        if (rnd < 0.08) type = 'mult5'; else if (rnd < 0.28) type = 'mult2';
        S.pegs.push({ fx, fy, type, alive: true });
      }
    }
    // 포켓 9칸: 레인별 3칸, 캐릭터 gol 만큼 충전
    S.pockets = [];
    for (let i = 0; i < 9; i++) {
      const lane = Math.floor(i / 3), sub = i % 3;
      const c = S.chars.find(ch => ch.lane === lane);
      const type = (c && sub < c.ref.gol) ? 'charge' : 'blank';
      S.pockets.push({ lane, type });
    }
  }

  function applyPassive(p) {
    if (!p) return;
    if (p.kind === 'addBall') S.passiveBalls += p.n;
    else if (p.kind === 'addPeg') addPegToBoard(S, p.peg, p.n);
    else if (p.kind === 'closeBlank') { for (let i = 0; i < p.n; i++) openOneBlank(S); }
  }

  // ============ 장전 phase ============
  function enterLoad() {
    S.phase = 'load';
    for (const c of S.chars) { c.ammo = 0; c.armed = false; }
    for (const p of S.pegs) p.alive = true;        // 특수 페그 턴마다 초기화
    S.launchesLeft = CFG.launchesPerTurn + S.bonusBalls + S.passiveBalls;
    S.balls = [];
    $('c-phase').textContent = '장전';
    renderSkills();
  }

  // 조준 방향(항상 위로 향하게 클램프)
  function aimDir(tx, ty) {
    const L = launcher();
    let dx = tx - L.x, dy = ty - L.y;
    const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
    if (dy > -CFG.aimMinUp) { dy = -CFG.aimMinUp; dx = Math.sign(dx || 1) * Math.sqrt(Math.max(0, 1 - dy * dy)); }
    return { dx, dy };
  }
  function launchBall(dir) {
    if (S.phase !== 'load' || S.launchesLeft <= 0 || S.over) return;
    const L = launcher();
    if (!dir) { const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.5; dir = { dx: Math.cos(a), dy: Math.sin(a) }; }  // sim용 랜덤 상향
    S.balls.push({ x: L.x, y: L.y, vx: dir.dx * CFG.launchSpeed, vy: dir.dy * CFG.launchSpeed, r: CFG.ballRadius, age: 0 });
    S.launchesLeft--;
  }

  // 조준 예측선: 첫 페그(또는 상단·바닥) 접촉까지 결정적으로 시뮬
  function simulateAim(dir) {
    const r = layout().pins, topY = r.y, botY = r.y + r.h, pegR = CFG.pegRadius, br = CFG.ballRadius;
    let x = launcher().x, y = launcher().y, vx = dir.dx * CFG.launchSpeed, vy = dir.dy * CFG.launchSpeed;
    const pts = [{ x, y }]; const dt = 1 / 120;
    for (let i = 0; i < 500; i++) {
      vy += CFG.gravity * dt; x += vx * dt; y += vy * dt;
      if (x < r.x + br) { x = r.x + br; vx = Math.abs(vx) * CFG.wallRestitution; pts.push({ x, y }); }
      if (x > r.x + r.w - br) { x = r.x + r.w - br; vx = -Math.abs(vx) * CFG.wallRestitution; pts.push({ x, y }); }
      for (const p of S.pegs) { if (!p.alive) continue; const px = r.x + p.fx * r.w, py = r.y + p.fy * r.h; if (Math.hypot(x - px, y - py) < br + pegR) { pts.push({ x, y }); return pts; } }
      if (y <= topY || y - br > botY) { pts.push({ x, y }); return pts; }
      if (i % 2 === 0) pts.push({ x, y });
    }
    pts.push({ x, y }); return pts;
  }

  function stepBalls(dt) {
    const r = layout().pins; const topY = r.y, botY = r.y + r.h;
    const pegR = CFG.pegRadius;
    for (let i = S.balls.length - 1; i >= 0; i--) {
      const b = S.balls[i];
      b.age = (b.age || 0) + dt;
      if (b.age > CFG.ballLifetime) { landBall(b); S.balls.splice(i, 1); continue; }   // 오래 떠돌면 소멸 대신 상단에서 강제 충전
      const speed = Math.hypot(b.vx, b.vy);
      const sub = Math.min(8, 1 + Math.floor(speed * dt / pegR));
      const h = dt / sub;
      let gone = false;
      for (let s = 0; s < sub && !gone; s++) {
        b.vy += CFG.gravity * h;
        b.x += b.vx * h; b.y += b.vy * h;
        // 좌우 벽 반사
        if (b.x < r.x + b.r) { b.x = r.x + b.r; b.vx = Math.abs(b.vx) * CFG.wallRestitution; }
        if (b.x > r.x + r.w - b.r) { b.x = r.x + r.w - b.r; b.vx = -Math.abs(b.vx) * CFG.wallRestitution; }
        // 페그 충돌(결정적: 랜덤 없음)
        for (const p of S.pegs) {
          if (!p.alive) continue;
          const px = r.x + p.fx * r.w, py = r.y + p.fy * r.h;
          const dx = b.x - px, dy = b.y - py, dist = Math.hypot(dx, dy), min = b.r + pegR;
          if (dist < min) {
            const nx = dist ? dx / dist : 0, ny = dist ? dy / dist : -1;
            b.x += nx * (min - dist); b.y += ny * (min - dist);
            const vdot = b.vx * nx + b.vy * ny;
            b.vx -= (1 + CFG.restitution) * vdot * nx;
            b.vy -= (1 + CFG.restitution) * vdot * ny;
            anim.flashes.push({ x: px, y: py, t: 1 });
            if (p.type === 'mult2') { splitBall(b, 1); p.alive = false; }
            else if (p.type === 'mult5') { splitBall(b, 4); p.alive = false; }
          }
        }
        // 바닥은 반사 벽(무중력이라 볼은 사라지지 않고 위로 되돌아감)
        if (b.y > botY - b.r) { b.y = botY - b.r; b.vy = -Math.abs(b.vy) * CFG.wallRestitution; }
        if (b.y <= topY) { landBall(b); S.balls.splice(i, 1); gone = true; }          // 상단 포켓 도달 → 충전
      }
    }
    if (S.phase === 'load' && S.launchesLeft <= 0 && S.balls.length === 0) enterBattle();
  }

  function splitBall(b, n) {
    const sp = Math.max(520, Math.hypot(b.vx, b.vy));
    for (let k = 0; k < n && S.balls.length < CFG.maxBalls; k++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.7;   // 상향 부채꼴로 분열
      S.balls.push({ x: b.x, y: b.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: b.r, age: 0 });
    }
  }

  function landBall(b) {
    const g = layout().goal;
    let idx = Math.floor(((b.x - g.x) / g.w) * 9);
    idx = Math.max(0, Math.min(8, idx));
    const pk = S.pockets[idx];
    if (pk && pk.type === 'charge') {
      const c = S.chars.find(ch => ch.lane === pk.lane);
      if (c) { c.ammo++; c.gauge++; renderSkills(); }
      anim.floats.push({ x: g.x + (idx + 0.5) * (g.w / 9), y: g.y + 10, text: '+1', color: laneHex(pk.lane), t: 1 });
    }
  }

  // ============ 전투 phase ============
  function enterBattle() {
    S.phase = 'battle';
    $('c-phase').textContent = '전투';
    // 액티브 스킬 발동(자동 또는 armed) 결정 → 샷 큐 구성
    S.shotQueue = [];
    for (const c of S.chars) {
      const sk = c.ref.active;
      const eligible = c.gauge >= sk.gauge;
      const use = eligible && (S.autoSkill || c.armed);
      if (use) { applyActive(c, sk); c.gauge = 0; }
      c.armed = false;
      // 일반 공격: 탄환 수만큼
      for (let k = 0; k < c.ammo; k++) S.shotQueue.push({ lane: c.lane, dmg: c.ref.atk + S.atkBonus });
    }
    // 스킬로 추가된 샷은 applyActive에서 unshift됨
    S.battleTimer = 0;
    S.battleStage = 'intro';
    renderSkills();
  }

  function applyActive(c, sk) {
    if (sk.kind === 'bigHit') S.shotQueue.push({ lane: c.lane, dmg: (c.ref.atk + S.atkBonus) * sk.mult, big: true });
    else if (sk.kind === 'extraShots') { for (let k = 0; k < sk.shots; k++) S.shotQueue.push({ lane: c.lane, dmg: c.ref.atk + S.atkBonus }); }
    else if (sk.kind === 'heal') { S.wallHp = Math.min(S.wallHpMax, S.wallHp + sk.amount); anim.floats.push({ x: W / 2, y: layout().wall.y + 12, text: '+' + sk.amount, color: '#6cf', t: 1.2 }); }
  }

  function frontmostEnemy() {
    let best = null;
    for (const e of S.enemies) { if (!best || e.row < best.row || (e.row === best.row && e.lane < best.lane)) best = e; }
    return best;
  }

  function stepBattle(dt) {
    S.battleTimer += dt * 1000;
    // 도입: 필드가 커진 걸 잠깐 보여준 뒤 공격 시작
    if (S.battleStage === 'intro') {
      if (S.battleTimer < CFG.battleStartDelay) return;
      S.battleTimer = 0; S.battleStage = 'shooting'; return;
    }
    // 마무리: 마지막 공격 후 잠깐 멈췄다 적 전진
    if (S.battleStage === 'outro') {
      if (S.battleTimer < CFG.battleEndDelay) return;
      S.battleStage = 'done'; endBattle(); return;
    }
    // 공격 진행
    if (S.battleTimer < CFG.battleShotDelay) return;
    S.battleTimer = 0;
    if (S.shotQueue.length === 0) { S.battleStage = 'outro'; S.battleTimer = 0; return; }
    const shot = S.shotQueue.shift();
    const e = frontmostEnemy();
    if (!e) { S.shotQueue = []; S.battleStage = 'outro'; S.battleTimer = 0; return; }
    let dmg = shot.dmg;
    if (e.isBoss && e.stun > 0) dmg = Math.round(dmg * (1 + BOSS_GOLEM.vulnerable));
    e.hp -= dmg;
    const pos = enemyPos(e);
    anim.floats.push({ x: pos.x, y: pos.y, text: String(dmg), color: shot.big ? '#ffcf5c' : '#fff', t: .9, big: shot.big });
    anim.flashes.push({ x: pos.x, y: pos.y, t: 1, big: true });
    if (e.hp <= 0) killEnemy(e);
  }

  function killEnemy(e) {
    const idx = S.enemies.indexOf(e); if (idx >= 0) S.enemies.splice(idx, 1);
    gainExp(e.exp);
    if (e.isBoss) { winRun(); }
  }

  function gainExp(x) {
    S.exp += x;
    while (S.exp >= S.expNext) { S.exp -= S.expNext; S.level++; S.expNext = expToNext(S.level); S.pendingRewards++; }
    syncHud();
  }

  function endBattle() {
    if (S.over) return;
    if (S.pendingRewards > 0) { showReward(); return; }   // 보상 먼저 다 받고
    advanceEnemies();
  }

  // ============ 적 전진·스폰 ============
  function advanceEnemies() {
    S._turns = (S._turns || 0) + 1;
    // 보스 스턴이면 이번 턴 전진 스킵
    for (const e of S.enemies.slice()) {
      if (e.isBoss && e.stun > 0) { e.stun--; continue; }
      e.row -= 1;
      if (e.row < 0) {
        S.wallHp -= e.dmg;
        anim.floats.push({ x: W / 2, y: layout().wall.y + 20, text: '-' + e.dmg, color: '#ff6b6b', t: 1.2, big: true });
        if (e.isBoss) { e.row = boss_retreatRow(); }   // 보스는 큰 피해 후 뒤로
        else { const i = S.enemies.indexOf(e); if (i >= 0) S.enemies.splice(i, 1); }
      }
    }
    if (S.wallHp <= 0) { S.wallHp = 0; loseRun(); return; }
    // 스폰
    if (!S.combat.boss) {
      if (S.enemies.length === 0 && S.waves.length === 0) { winCombat(); return; }
      if (S.waves.length > 0) spawnWave();
    }
    syncHud();
    enterLoad();
  }

  function boss_retreatRow() { return Math.min(CFG.fieldRows - 1, Math.round(CFG.fieldRows / 2)); }

  function spawnWave() {
    const w = S.waves.shift(); if (!w) return;
    w.forEach((type, k) => {
      const def = ENEMIES[type];
      const lane = k % CFG.lanes;
      const row = CFG.fieldRows - 1 - Math.floor(k / CFG.lanes);
      S.enemies.push({ type, name: def.name, lane, row, hp: def.hp, maxHp: def.hp, dmg: def.dmg, exp: def.exp, color: def.color, stun: 0 });
    });
  }

  function spawnBoss() {
    const b = BOSS_GOLEM;
    S.enemies.push({ isBoss: true, name: b.name, lane: 1, row: CFG.fieldRows - 1, hp: b.hp, maxHp: b.hp, dmg: b.dmg, exp: b.exp, color: b.color, stun: 0, thHit: 0 });
  }

  // 보스 임계 체크(전투 phase 데미지 적용 후 호출용) — 매 프레임 검사
  function checkBossThreshold() {
    const e = S.enemies.find(x => x.isBoss); if (!e) return;
    const frac = e.hp / e.maxHp;
    while (e.thHit < BOSS_GOLEM.thresholds.length && frac <= BOSS_GOLEM.thresholds[e.thHit]) {
      e.thHit++;
      e.row = Math.min(CFG.fieldRows - 1, e.row + BOSS_GOLEM.retreat);
      e.stun = BOSS_GOLEM.stunTurns;
      anim.floats.push({ x: enemyPos(e).x, y: enemyPos(e).y - 20, text: '휘청!', color: '#ffcf5c', t: 1.2 });
    }
  }

  // ============ 보상 ============
  function showReward() {
    const box = $('reward-choices'); box.replaceChildren();
    const pool = REWARDS.slice(); const pick = [];
    for (let i = 0; i < 3 && pool.length; i++) pick.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    $('reward-sub').textContent = '남은 보상 ' + S.pendingRewards + '개 · 하나를 고르세요';
    pick.forEach(rw => {
      const b = document.createElement('button'); b.className = 'reward-card';
      b.innerHTML = '<div class="rc-name">' + rw.name + '</div><div class="rc-desc">' + rw.desc + '</div>';
      b.onclick = () => {
        rw.apply(S); S.pendingRewards--; $('reward').hidden = true; syncHud();
        if (S.pendingRewards > 0) showReward(); else advanceEnemies();
      };
      box.append(b);
    });
    $('reward').hidden = false;
  }

  // ============ 승패 ============
  function winCombat() {
    if (S.combatIndex + 1 < COMBATS.length) { startCombat(S.combatIndex + 1); }
    else winRun();
  }
  function winRun() { S.over = true; endResult('승리', '모든 전투와 보스를 돌파했습니다. 레벨 ' + S.level + ' 도달.'); }
  function loseRun() { S.over = true; endResult('패배', S.combat.name + '에서 성벽이 무너졌습니다.'); }
  function endResult(title, body) {
    $('result-title').textContent = title; $('result-body').textContent = body; $('result').hidden = false;
  }

  // ============ 렌더 ============
  function laneColor(l) { return ['var(--lane0)', 'var(--lane1)', 'var(--lane2)'][l] || '#fff'; }
  function laneHex(l) { return ['#46e6d0', '#ffcf5c', '#ff5db1'][l] || '#fff'; }

  function enemyPos(e) {
    const r = layout().field;
    const laneW = r.w / CFG.lanes;
    const x = r.x + (e.lane + 0.5) * laneW;
    const y = r.y + (CFG.fieldRows - 1 - e.row + 0.5) * (r.h / CFG.fieldRows);
    return { x, y };
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const r = layout();
    // 필드 배경
    ctx.fillStyle = '#ffffff08'; ctx.fillRect(r.field.x, r.field.y, r.field.w, r.field.h);
    // 레인 구분선
    ctx.strokeStyle = '#ffffff12'; ctx.lineWidth = 1;
    for (let l = 1; l < CFG.lanes; l++) { const x = r.field.w / CFG.lanes * l; ctx.beginPath(); ctx.moveTo(x, r.field.y); ctx.lineTo(x, r.wall.y + r.wall.h); ctx.stroke(); }
    // 적
    for (const e of S.enemies) {
      const p = enemyPos(e); const rad = e.isBoss ? 26 : 15;
      ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 7); ctx.fillStyle = e.stun > 0 ? '#c9c2ff' : e.color; ctx.fill();
      if (e.isBoss) { ctx.lineWidth = 3; ctx.strokeStyle = '#fff6'; ctx.stroke(); }
      // hp bar
      const bw = rad * 2, bx = p.x - rad, by = p.y + rad + 3;
      ctx.fillStyle = '#0008'; ctx.fillRect(bx, by, bw, 4);
      ctx.fillStyle = '#ff6b6b'; ctx.fillRect(bx, by, bw * Math.max(0, e.hp / e.maxHp), 4);
    }
    // 성벽
    ctx.fillStyle = '#ffffff10'; ctx.fillRect(r.wall.x, r.wall.y, r.wall.w, r.wall.h);
    const laneW = r.wall.w / CFG.lanes;
    for (const c of S.chars) {
      const x = r.wall.x + (c.lane + 0.5) * laneW, y = r.wall.y + r.wall.h / 2;
      ctx.fillStyle = laneHex(c.lane); ctx.beginPath(); ctx.arc(x, y - 4, 10, 0, 7); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(c.ref.name, x, y + 16);
      if (S.phase === 'load' && c.ammo > 0) { ctx.fillStyle = '#ffcf5c'; ctx.font = 'bold 12px system-ui'; ctx.fillText('◆' + c.ammo, x, y - 20); }
    }
    // 성벽 HP 바
    ctx.fillStyle = '#0006'; ctx.fillRect(r.wall.x + 6, r.wall.y + r.wall.h - 8, r.wall.w - 12, 5);
    ctx.fillStyle = '#46e6d0'; ctx.fillRect(r.wall.x + 6, r.wall.y + r.wall.h - 8, (r.wall.w - 12) * Math.max(0, S.wallHp / S.wallHpMax), 5);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'left';
    ctx.fillText('성벽 ' + Math.ceil(S.wallHp) + '/' + S.wallHpMax, r.wall.x + 8, r.wall.y + 12);

    // 핀볼 필드
    ctx.fillStyle = '#00000022'; ctx.fillRect(r.pins.x, r.pins.y, r.pins.w, r.pins.h);
    for (const p of S.pegs) {
      const px = r.pins.x + p.fx * r.pins.w, py = r.pins.y + p.fy * r.pins.h;
      ctx.beginPath(); ctx.arc(px, py, CFG.pegRadius, 0, 7);
      if (!p.alive) { ctx.fillStyle = '#2a2648'; ctx.fill(); continue; }
      ctx.fillStyle = p.type === 'mult5' ? '#ff5db1' : p.type === 'mult2' ? '#ffcf5c' : '#8f86d6';
      ctx.fill();
      if (p.type !== 'normal') { ctx.fillStyle = '#1a1430'; ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center'; ctx.fillText(p.type === 'mult5' ? '×5' : '×2', px, py + 3); }
    }
    // 볼
    for (const b of S.balls) { ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.fillStyle = '#eafcff'; ctx.fill(); }
    // 발사대(하단 중앙) + 조준 가이드
    if (S.phase === 'load') {
      const L = launcher();
      ctx.fillStyle = S.launchesLeft > 0 ? '#ffcf5c' : '#555';
      ctx.beginPath(); ctx.arc(L.x, L.y, 11, 0, 7); ctx.fill();
      if (aimActive && S.launchesLeft > 0) {
        const pts = simulateAim(aimDir(aimX, aimY));
        ctx.save(); ctx.strokeStyle = '#ffffffaa'; ctx.lineWidth = 2; ctx.setLineDash([5, 7]);
        ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (const pt of pts) ctx.lineTo(pt.x, pt.y); ctx.stroke();
        const end = pts[pts.length - 1];
        ctx.setLineDash([]); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(end.x, end.y, 4, 0, 7); ctx.fill();
        ctx.restore();
      }
    }

    // 골 포켓
    const g = r.goal, pw = g.w / 9;
    for (let i = 0; i < 9; i++) {
      const pk = S.pockets[i]; const x = g.x + i * pw;
      ctx.fillStyle = pk.type === 'charge' ? laneHex(pk.lane) + '55' : '#ffffff08';
      ctx.fillRect(x + 1, g.y + 2, pw - 2, g.h - 4);
      ctx.strokeStyle = '#ffffff18'; ctx.strokeRect(x + 1, g.y + 2, pw - 2, g.h - 4);
      ctx.fillStyle = pk.type === 'charge' ? laneHex(pk.lane) : '#4a4570';
      ctx.font = 'bold 12px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(pk.type === 'charge' ? '◆' : '×', x + pw / 2, g.y + g.h / 2 + 4);
    }

    // 플로팅 텍스트
    for (const f of anim.floats) {
      ctx.globalAlpha = Math.max(0, f.t); ctx.fillStyle = f.color; ctx.textAlign = 'center';
      ctx.font = 'bold ' + (f.big ? 18 : 13) + 'px system-ui';
      ctx.fillText(f.text, f.x, f.y - (1 - f.t) * 24); ctx.globalAlpha = 1;
    }
    for (const fl of anim.flashes) {
      ctx.globalAlpha = fl.t * 0.5; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(fl.x, fl.y, (fl.big ? 16 : 10) * (1.4 - fl.t), 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
    }
    // 전투 시작 배너
    if (S.phase === 'battle' && S.battleStage === 'intro') {
      ctx.fillStyle = '#ffcf5c'; ctx.textAlign = 'center'; ctx.font = 'bold 34px system-ui';
      ctx.fillText('전투!', W / 2, r.field.y + r.field.h * 0.5);
    }
  }

  // ============ 루프 ============
  function loop(ts) {
    const d = Math.min(0.032, (ts - lastTs) / 1000 || 0.016); lastTs = ts;
    if (S && !S.over) {
      if (S.phase === 'load') stepBalls(d);
      else if (S.phase === 'battle') { stepBattle(d); checkBossThreshold(); }
      for (let i = anim.floats.length - 1; i >= 0; i--) { anim.floats[i].t -= d * 1.2; if (anim.floats[i].t <= 0) anim.floats.splice(i, 1); }
      for (let i = anim.flashes.length - 1; i >= 0; i--) { anim.flashes[i].t -= d * 3; if (anim.flashes[i].t <= 0) anim.flashes.splice(i, 1); }
      draw();
    }
    requestAnimationFrame(loop);
  }

  // ============ HUD·스킬 UI ============
  function syncHud() {
    $('c-level').textContent = 'Lv.' + S.level;
    $('exp-fill').style.width = (100 * S.exp / S.expNext) + '%';
  }
  function renderSkills() {
    const row = $('skill-row'); row.replaceChildren();
    for (const c of S.chars) {
      const sk = c.ref.active; const ready = c.gauge >= sk.gauge;
      const b = document.createElement('button');
      b.className = 'skillbtn' + (ready ? ' ready' : '') + (c.armed ? ' armed' : '');
      b.textContent = c.ref.name + ' ' + sk.name + ' ' + Math.min(c.gauge, sk.gauge) + '/' + sk.gauge;
      b.onclick = () => { if (c.gauge >= sk.gauge) { c.armed = !c.armed; renderSkills(); } };
      row.append(b);
    }
  }

  // ============ 입력 ============
  function canvasPoint(e) { const rect = canvas.getBoundingClientRect(); return { x: e.clientX - rect.left, y: e.clientY - rect.top }; }
  function aimDown(e) { if (!S || S.phase !== 'load' || S.launchesLeft <= 0) return; e.preventDefault(); aimActive = true; const p = canvasPoint(e); aimX = p.x; aimY = p.y; }
  function aimMove(e) { if (!aimActive) return; e.preventDefault(); const p = canvasPoint(e); aimX = p.x; aimY = p.y; }
  function aimUp(e) { if (!aimActive) return; e.preventDefault(); aimActive = false; launchBall(aimDir(aimX, aimY)); }

  // ============ 로비 ============
  function renderLobby() {
    const pv = $('party-preview'); pv.replaceChildren();
    for (const id of ROSTER.map(c => c.id)) {
      const c = roster(id); const d = document.createElement('div'); d.className = 'party-card';
      d.innerHTML = '<div class="pc-name">' + c.name + '</div><div class="pc-stat">공격 ' + c.atk + ' · 체력 ' + c.hp + ' · 골칸 ' + c.gol + '</div>';
      pv.append(d);
    }
  }

  // ============ 와이어링 ============
  $('btn-start').onclick = () => { show('lobby'); renderLobby(); };
  document.querySelectorAll('.tabbtn').forEach(t => t.onclick = () => {
    document.querySelectorAll('.tabbtn').forEach(x => x.classList.toggle('active', x === t));
    $('tab-sortie').hidden = t.dataset.tab !== 'sortie';
    $('tab-shop').hidden = t.dataset.tab !== 'shop';
  });
  $('btn-sortie').onclick = () => startRun();
  $('btn-result').onclick = () => { $('result').hidden = true; show('lobby'); renderLobby(); };
  $('btn-auto').onclick = () => { S.autoSkill = !S.autoSkill; $('btn-auto').textContent = '자동 ' + (S.autoSkill ? 'ON' : 'OFF'); $('btn-auto').classList.toggle('on', S.autoSkill); };
  canvas.addEventListener('pointerdown', aimDown);
  canvas.addEventListener('pointermove', aimMove);
  canvas.addEventListener('pointerup', aimUp);
  canvas.addEventListener('pointercancel', () => { aimActive = false; });
  window.addEventListener('resize', () => { if (!$('combat').hidden) resize(); });

  // 디버그/스모크 훅
  window.__PONGTRESS__ = {
    get S() { return S; }, startRun, launchBall, enterBattle, CFG,
    tick(dt) { if (!S || S.over) return; if (S.phase === 'load') stepBalls(dt); else if (S.phase === 'battle') { stepBattle(dt); checkBossThreshold(); } },
    render() { if (S) draw(); }
  };

  // 헤드리스 자가 테스트: ?sim=1 로 런을 자동 진행하며 런타임 오류·상태를 #boot-error 에 남긴다.
  function runSelfTest() {
    startRun();
    if (new URLSearchParams(location.search).has('win')) { S.atkBonus += 60; S.autoSkill = true; }
    let ticks = 0, launched = 0;
    const iv = setInterval(() => {
      ticks++;
      try {
        // 헤드리스에선 rAF가 안 도므로 물리를 직접 펌핑(브라우저는 loop가 담당)
        for (let k = 0; k < 6 && !S.over; k++) {
          if (S.phase === 'load') stepBalls(0.03);
          else if (S.phase === 'battle') { stepBattle(0.03); checkBossThreshold(); }
        }
        if (!$('result').hidden) { done('result:' + $('result-title').textContent); return; }
        if (!$('reward').hidden) { const b = document.querySelector('.reward-card'); if (b) b.click(); return; }
        if (S.phase === 'load' && S.launchesLeft > 0 && S.balls.length === 0) { launchBall(); launched++; return; }
        if (ticks > 1500) { done('timeout'); }
      } catch (e) { done('EXC:' + e.message + ' @' + (e.stack ? e.stack.split('\n')[1].trim() : '?')); }
    }, 8);
    function done(msg) { clearInterval(iv); const s = S || {}; boot('SIM ' + msg + ' | phase=' + s.phase + ' launchesLeft=' + s.launchesLeft + ' balls=' + (s.balls ? s.balls.length : '?') + ' launched=' + launched + ' lvl=' + s.level + ' wall=' + Math.ceil(s.wallHp || 0) + '/' + s.wallHpMax + ' combat=' + s.combatIndex + ' enemies=' + (s.enemies ? s.enemies.length : '?') + ' turns=' + (s._turns || 0)); }
  }
  if (new URLSearchParams(location.search).has('sim')) setTimeout(runSelfTest, 50);
})();
