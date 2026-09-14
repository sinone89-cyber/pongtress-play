'use strict';
/* PONGTRESS — 프로토타입 0.1
 * 로그라이크 + 핀볼. 위쪽 발사대에서 오브를 쏘아 펙(peg)에 튕기고,
 * 펙을 맞힐 때마다 적에게 피해를 준다. 몇 발마다 적이 반격한다.
 * 지금은 한 파일에 전부 담은 수직 슬라이스다. 이후 physics/content 로 분리 예정.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const boot = (msg) => { const b = $('boot-error'); b.hidden = false; b.textContent = 'ERROR: ' + msg; };
  window.addEventListener('error', (e) => boot(e.message));

  // ---------- 튜닝 값 ----------
  const CFG = {
    gravity: 1400,        // px/s^2
    restitution: 0.72,    // 반발 계수
    wallRestitution: 0.7,
    launchSpeed: 620,     // 발사 속도 px/s
    ballRadius: 9,
    pegRadius: 11,
    pegDamage: 6,         // 펙 하나 맞힐 때 피해
    maxSubsteps: 8,
    enemyEveryShots: 3,   // 몇 발마다 적이 반격
    enemyAttack: 12,      // 반격 피해
    playerHpMax: 60
  };

  // ---------- 상태 ----------
  const state = {
    screen: 'title',
    floor: 1,
    playerHp: CFG.playerHpMax,
    enemy: null,
    pegs: [],
    ball: null,
    aiming: false,
    aim: { x: 0, y: 0 },
    launcher: { x: 0, y: 48 },
    shots: 0,
    shotDamage: 0,     // 이번 발사로 누적된 피해
    settleTimer: 0
  };

  const canvas = $('stage');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1;

  function resize() {
    const wrap = $('stage-wrap');
    const rect = wrap.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(240, Math.floor(rect.width));
    H = Math.max(320, Math.floor(rect.height));
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.launcher.x = W / 2;
  }

  // ---------- 층 구성 ----------
  const ENEMY_NAMES = ['허수아비', '슬라임', '박쥐 무리', '골렘', '망령', '수문장'];

  function makeFloor(n) {
    const name = ENEMY_NAMES[Math.min(n - 1, ENEMY_NAMES.length - 1)];
    const hpMax = 40 + (n - 1) * 26;
    state.enemy = { name, hp: hpMax, hpMax, attackIn: CFG.enemyEveryShots };
    state.shots = 0;
    state.shotDamage = 0;
    layoutPegs(n);
    state.ball = null;
    state.aiming = false;
    $('hud-floor').textContent = String(n);
    $('hud-enemy-name').textContent = name;
    syncHud();
  }

  function layoutPegs(n) {
    state.pegs = [];
    const cols = 7, rows = 6 + Math.min(n, 4);
    const top = 130, bottom = H - 150;
    const gapY = (bottom - top) / (rows - 1);
    const marginX = 34;
    const spanX = W - marginX * 2;
    for (let r = 0; r < rows; r++) {
      const offset = (r % 2) ? spanX / (cols * 2) : 0;
      for (let c = 0; c < cols; c++) {
        // 살짝 흩뿌려 규칙성을 깬다
        if (Math.random() < 0.14) continue;
        const x = marginX + offset + (spanX / cols) * c + (Math.random() - 0.5) * 8;
        const y = top + gapY * r + (Math.random() - 0.5) * 6;
        if (x < marginX || x > W - marginX) continue;
        state.pegs.push({ x, y, r: CFG.pegRadius, alive: true, flash: 0 });
      }
    }
  }

  // ---------- 발사 / 물리 ----------
  function fire() {
    if (state.ball || state.screen !== 'play') return;
    const dx = state.aim.x - state.launcher.x;
    let dy = state.aim.y - state.launcher.y;
    if (dy < 20) dy = 20; // 항상 아래쪽으로
    const len = Math.hypot(dx, dy) || 1;
    state.ball = {
      x: state.launcher.x, y: state.launcher.y + 6,
      vx: (dx / len) * CFG.launchSpeed,
      vy: (dy / len) * CFG.launchSpeed,
      r: CFG.ballRadius
    };
    state.shots++;
    state.shotDamage = 0;
    for (const p of state.pegs) p.alive = true; // 매 발사마다 펙 새로고침
    $('hud-shots').textContent = String(state.shots);
  }

  function stepBall(dt) {
    const b = state.ball;
    if (!b) return;
    // 빠른 이동 시 관통 방지: 이동 거리를 나눠 처리
    const speed = Math.hypot(b.vx, b.vy);
    const steps = Math.min(CFG.maxSubsteps, 1 + Math.floor(speed * dt / (CFG.pegRadius)));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      b.vy += CFG.gravity * h;
      b.x += b.vx * h;
      b.y += b.vy * h;
      // 벽
      if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx) * CFG.wallRestitution; }
      if (b.x > W - b.r) { b.x = W - b.r; b.vx = -Math.abs(b.vx) * CFG.wallRestitution; }
      if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy) * CFG.wallRestitution; }
      // 펙 충돌
      for (const p of state.pegs) {
        if (!p.alive) continue;
        const dx = b.x - p.x, dy = b.y - p.y;
        const dist = Math.hypot(dx, dy);
        const min = b.r + p.r;
        if (dist < min) {
          const nx = dist ? dx / dist : 0, ny = dist ? dy / dist : -1;
          const overlap = min - dist;
          b.x += nx * overlap; b.y += ny * overlap;
          const vDotN = b.vx * nx + b.vy * ny;
          b.vx -= (1 + CFG.restitution) * vDotN * nx;
          b.vy -= (1 + CFG.restitution) * vDotN * ny;
          p.alive = false; p.flash = 1;
          hitPeg(p);
        }
      }
    }
    // 바닥으로 빠지면 발사 종료
    if (b.y - b.r > H) endShot();
  }

  function hitPeg(p) {
    state.shotDamage += CFG.pegDamage;
    state.enemy.hp = Math.max(0, state.enemy.hp - CFG.pegDamage);
    $('hud-damage').textContent = String(state.shotDamage);
    syncHud();
  }

  function endShot() {
    state.ball = null;
    if (state.enemy.hp <= 0) { win(); return; }
    // 적 반격 카운트
    state.enemy.attackIn--;
    if (state.enemy.attackIn <= 0) {
      state.enemy.attackIn = CFG.enemyEveryShots;
      state.playerHp = Math.max(0, state.playerHp - CFG.enemyAttack);
      toast(state.enemy.name + '의 반격! -' + CFG.enemyAttack);
      syncHud();
      if (state.playerHp <= 0) { lose(); return; }
    }
  }

  // ---------- 결과 ----------
  function win() {
    state.ball = null;
    show('result');
    $('result-title').textContent = state.floor + '층 돌파';
    $('result-body').textContent = state.enemy.name + '을(를) 쓰러뜨렸다. 다음 층으로.';
    $('btn-next').textContent = '다음 층';
    state.pendingNext = () => { state.floor++; startFloor(); };
  }
  function lose() {
    state.ball = null;
    show('result');
    $('result-title').textContent = '쓰러졌다';
    $('result-body').textContent = state.floor + '층에서 끝났다. 처음부터 다시.';
    $('btn-next').textContent = '다시 시작';
    state.pendingNext = () => { state.floor = 1; state.playerHp = CFG.playerHpMax; startFloor(); };
  }

  // ---------- HUD ----------
  function syncHud() {
    const e = state.enemy;
    if (e) {
      $('hud-enemy-hp').style.width = (100 * e.hp / e.hpMax) + '%';
    }
    $('hud-player-hp').style.width = (100 * state.playerHp / CFG.playerHpMax) + '%';
  }
  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1400);
  }

  // ---------- 렌더 ----------
  function draw() {
    ctx.clearRect(0, 0, W, H);
    // 발사대
    const L = state.launcher;
    ctx.save();
    ctx.fillStyle = '#ffcf5c';
    ctx.beginPath(); ctx.arc(L.x, L.y, 12, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // 조준선
    if (state.aiming && !state.ball) {
      let dx = state.aim.x - L.x, dy = state.aim.y - L.y;
      if (dy < 20) dy = 20;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      ctx.save();
      ctx.strokeStyle = '#ffffff55'; ctx.lineWidth = 2; ctx.setLineDash([4, 8]);
      ctx.beginPath(); ctx.moveTo(L.x, L.y);
      ctx.lineTo(L.x + ux * 160, L.y + uy * 160); ctx.stroke();
      ctx.restore();
    }
    // 펙
    for (const p of state.pegs) {
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      if (p.alive) {
        ctx.fillStyle = '#8f86d6';
        ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = '#c9c2ff';
        ctx.stroke();
      } else {
        ctx.fillStyle = p.flash > 0 ? '#ffcf5c' : '#3a3560';
        ctx.fill();
      }
      if (p.flash > 0) p.flash = Math.max(0, p.flash - 0.08);
    }
    // 오브
    const b = state.ball;
    if (b) {
      ctx.save();
      ctx.shadowColor = '#46e6d0'; ctx.shadowBlur = 14;
      ctx.fillStyle = '#46e6d0';
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  // ---------- 루프 ----------
  let last = 0;
  function loop(ts) {
    const dt = Math.min(0.032, last ? (ts - last) / 1000 : 0.016);
    last = ts;
    if (state.screen === 'play') { stepBall(dt); draw(); }
    requestAnimationFrame(loop);
  }

  // ---------- 입력 ----------
  function canvasPoint(ev) {
    const rect = canvas.getBoundingClientRect();
    const t = ev.touches ? ev.touches[0] : ev;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }
  canvas.addEventListener('pointerdown', (ev) => {
    if (state.ball) return;
    state.aiming = true; state.aim = canvasPoint(ev);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (state.aiming) state.aim = canvasPoint(ev);
  });
  canvas.addEventListener('pointerup', () => {
    if (state.aiming) { state.aiming = false; fire(); }
  });
  canvas.addEventListener('pointercancel', () => { state.aiming = false; });

  // ---------- 화면 전환 ----------
  function show(name) {
    state.screen = name;
    for (const s of ['title', 'play', 'result']) $(s).hidden = (s !== name);
  }
  function startFloor() {
    show('play');
    resize();
    makeFloor(state.floor);
  }

  $('btn-start').addEventListener('click', () => { state.floor = 1; state.playerHp = CFG.playerHpMax; startFloor(); });
  $('btn-next').addEventListener('click', () => { if (state.pendingNext) state.pendingNext(); });
  window.addEventListener('resize', () => { if (state.screen === 'play') resize(); });

  // 시작
  resize();
  requestAnimationFrame(loop);
  window.__PONGTRESS__ = { state, CFG }; // 디버그/스모크용
})();
