/* ==========================================================================
   demo-scenario.js — 台帳マップ（3方式比較）の上で進める「シナリオで学ぶ」モード
   /admin/demo?scenario=a〜d で開始する。
     A 正規の更新：値を更新すると、付随する情報（複製・ハッシュ・ブロック）がどう更新されるか（目的1：構造）
     B データの書換え：マルウェアが正規の手続きを踏まずに値だけを書き換えたら、どうなるか（改ざんへの耐性）
     C 1台の故障：VM1 が止まっている間に受け付けられるか（可用性）
     D 2台の故障：過半数が止まると、ブロックチェーンでも書き込めない（限界）
   流れ：解説 → 体験 → まとめ。変化のたびに、変わった所を光らせて確認してから次へ進む。
   光らせ方は1種類（青）。正規の手続きを通らない変化だけ赤にする。
   画面上の値はブラウザ内のシミュレーション（Mock）。実際のブロックチェーンには書き込まない。
   core / c03 / c01c02 / api / bind / compare の各スクリプトより後に読み込む。
   ========================================================================== */
(function () {
  'use strict';

  const ITEM = { id: 'PRJ-01', name: 'プロジェクター', category: '映像機器', quantity: 6, location: '研究室' };
  const BASE_QTY = 5; // 正規の更新（1台を廃棄）のあとの個数
  const TAMPERED_QTY = 3; // マルウェアが書き換える値
  const METHODS = [
    { id: 'single', name: '単一DB' },
    { id: 'hash', name: 'DB＋ハッシュ' },
    { id: 'fabric', name: 'ブロックチェーン' },
  ];
  const STEPS = ['解説', '体験', 'まとめ'];

  const params = new URLSearchParams(window.__staticSearch != null ? window.__staticSearch : window.location.search);
  const SCN = (params.get('scenario') || '').toLowerCase();
  if (!['a', 'b', 'c', 'd'].includes(SCN)) return;
  const NAMES = { a: 'シナリオA 正規の更新', b: 'シナリオB データの書換え', c: 'シナリオC 1台の故障', d: 'シナリオD 2台の故障' };
  const NEXT = { a: 'b', b: 'c', c: 'd' };
  const IS_FAIL = SCN === 'c' || SCN === 'd';
  // 故障シナリオで止めるサーバー（VM1 は単一DB・DB＋ハッシュの記録＝マシン1 も載せている）
  const STOP_LIST = SCN === 'c' ? [0] : [0, 1];
  const VM_KEYS = ['master', 'slave0', 'slave1']; // 単一DB・DB＋ハッシュで VM1〜VM3 に載っているマシン

  const S = {
    step: 0,
    introPage: 0,
    phase: 0, // 体験の進み具合（シナリオごとに意味が違う）
    legit: null, // 正規の更新の内容 { qty, reason }
    audits: { single: null, hash: null, fabric: null }, // 方式ごとの直近のチェック結果
    auditing: false,
    guiding: false,
    shown: null,
    trials: [],
    tries: [], // 故障シナリオで申請した結果
    pending: new Set(), // まだ届いていないブロック（"peerId-num"）と状態DB（"couch-peerId"）
    events: [],
    startedAt: new Date().toISOString(),
    ready: false,
  };
  const log = (type, detail = {}) => S.events.push({ t: new Date().toISOString(), type, ...detail });
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- 画面の骨組み ----------
  function mountShell() {
    document.body.dataset.learn = SCN;
    const title = document.querySelector('.workspace-title');
    if (title && !$('scnHead')) {
      title.insertAdjacentHTML('beforeend', `
        <div class="scn-head" id="scnHead">
          <span class="scn-badge">${NAMES[SCN]}</span>
          <ol class="scn-steps" id="scnSteps"></ol>
          <button type="button" class="scn-exit" id="scnExit">シナリオを終える</button>
        </div>`);
      $('scnExit').addEventListener('click', () => { window.__goDemo(''); });
    }
    const panel = document.querySelector('.control-panel');
    if (panel && !$('scnPanel')) panel.insertAdjacentHTML('afterbegin', '<section id="scnPanel" aria-live="polite"></section>');
    const heading = document.querySelector('.mockup-controls .rail-heading span');
    if (heading) heading.textContent = 'シナリオの進め方';
    if (window.TutorialOverlay && typeof window.TutorialOverlay.isActive === 'function' && window.TutorialOverlay.isActive()) {
      try { window.TutorialOverlay.stop(); } catch (_) { /* 古いオーバーレイには stop がない */ }
    }
    // マップを描き直したら、記録のカード・止まったマシンの表示も描き直す
    if (typeof render === 'function' && !render.scnWrapped) {
      const orig = render;
      render = function scnRender(after) {
        orig(after);
        applyPending();
        requestAnimationFrame(() => requestAnimationFrame(() => { relabelMap(); drawRecordCard(); paintDown(); applyPending(); }));
      };
      render.scnWrapped = true;
    }
    window.addEventListener('resize', () => drawRecordCard());
  }

  /** シナリオ中はマップの専門用語を、初学者向けの言葉に置き換えて表示する */
  const RELABELS = [
    ['監査用の値', '照合用の値'], // 監査用の値
    ['複製（レプリケーション）', '自動で複製'],
    ['マスタ', '記録'], // マスタ
    ['スレーブ', '複製'], // スレーブ
  ];
  function relabelMap() {
    const world = $('mapWorld');
    if (!world) return;
    const walker = document.createTreeWalker(world, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      let v = n.nodeValue;
      RELABELS.forEach(([from, to]) => { if (v.includes(from)) v = v.split(from).join(to); });
      if (v !== n.nodeValue) n.nodeValue = v;
    }
  }

  // ---------- マップ上の位置 ----------
  /** マップ上の座標（拡大縮小やカメラの移動の途中でも変わらない、レイアウト上の位置） */
  function offsetInWorld(el, world) {
    let x = 0; let y = 0; let n = el;
    while (n && n !== world) {
      x += n.offsetLeft; y += n.offsetTop;
      n = n.offsetParent;
    }
    return n === world ? { x, y } : null;
  }
  function worldBox(els) {
    const world = $('mapWorld');
    let l = Infinity; let t = Infinity; let r = -Infinity; let b = -Infinity;
    els.filter((el) => el && el.getClientRects().length).forEach((el) => {
      const o = offsetInWorld(el, world);
      let box;
      if (o) box = { l: o.x, t: o.y, r: o.x + el.offsetWidth, b: o.y + el.offsetHeight };
      else {
        const wr = world.getBoundingClientRect();
        const rc = el.getBoundingClientRect();
        box = { l: (rc.left - wr.left) / view.scale, t: (rc.top - wr.top) / view.scale, r: (rc.right - wr.left) / view.scale, b: (rc.bottom - wr.top) / view.scale };
      }
      l = Math.min(l, box.l); t = Math.min(t, box.t); r = Math.max(r, box.r); b = Math.max(b, box.b);
    });
    return Number.isFinite(l) ? { l, t, r, b } : null;
  }
  /** ブロックチェーン方式の「記録」（VM1 の上の研究室のデータベース）を、VM1 の右に出す */
  function drawRecordCard() {
    const world = $('mapWorld');
    const lane = $('peerLane0');
    if (!world || !lane || document.body.dataset.compareView !== 'on') return null;
    let card = document.querySelector('.scn-record');
    const it = masterItems[ITEM.id];
    if (!it || IS_FAIL) { if (card) card.remove(); return null; }
    if (!card) {
      card = document.createElement('div');
      card.className = 'scn-record';
      world.appendChild(card);
    }
    const tampered = Boolean(it._tampered);
    card.classList.toggle('is-tampered', tampered);
    card.innerHTML = `<div class="scn-record-title">記録（VM1 のデータベース）</div>
      <div class="scn-record-row"><span>${esc(it.id)} ${esc(it.name || '')}</span></div>
      <div class="scn-record-qty"><span>個数</span><b>${it.quantity}</b><span>台</span>${tampered && typeof it._tamperedFromQty === 'number' ? `<small>（元：${it._tamperedFromQty}台）</small>` : ''}</div>
      <div class="scn-record-note">チェックでは、この記録を VM1〜VM3 の台帳と見比べます</div>`;
    const box = worldBox([lane]);
    if (!box) return card;
    card.style.left = `${box.r + 60}px`;
    card.style.top = `${box.t + 20}px`;
    return card;
  }

  // ---------- カメラ（見せたい所へマップを寄せる） ----------
  function focusOn(targets, opts = {}) {
    const stage = $('mapStage');
    const world = $('mapWorld');
    if (!stage || !world || typeof view === 'undefined') return;
    const els = (Array.isArray(targets) ? targets : [targets])
      .flatMap((t) => (typeof t === 'string' ? Array.from(document.querySelectorAll(t)) : [t]));
    // 前の移動の途中でも、確定した位置から測る
    world.classList.remove('is-camera');
    applyView();
    void world.offsetWidth;
    const box = worldBox(els);
    if (!box) return;
    const pad = opts.pad ?? 36;
    const w = box.r - box.l; const h = box.b - box.t;
    const scale = Math.max(0.2, Math.min(opts.max ?? 1.1, (stage.clientWidth - pad * 2) / w, (stage.clientHeight - pad * 2) / h));
    view.scale = scale;
    view.x = (stage.clientWidth - w * scale) / 2 - box.l * scale;
    view.y = (stage.clientHeight - h * scale) / 2 - box.t * scale;
    world.classList.add('is-camera');
    applyView();
    clearTimeout(focusOn.timer);
    focusOn.timer = setTimeout(() => {
      world.classList.remove('is-camera');
      drawRecordCard();
      if (typeof renderSvgArrows === 'function') renderSvgArrows();
      if (typeof renderHashLinkOverlay === 'function') renderHashLinkOverlay();
    }, 750);
  }
  const FOCUS = {
    all: ['#peerLane0', '#peerLane2', '.method-region', '.scn-record'],
    fabric: ['#peerLane0', '#peerLane1', '#peerLane2', '.scn-record'],
    single: ['.method-region[data-method="c01"]'],
    hash: ['.method-region[data-method="c02"]'],
  };
  function overview() { focusOn(FOCUS.all, { max: 1 }); }

  // ---------- 注目させる（変わった所へ寄せて光らせ、確認してから次へ） ----------
  // 変化のたびに一度止め、「変わりましたよね」を確認してから 3・2・1 のテンポで次へ進める
  const COUNT_MS = 700; // 「確認した」を押せるようになるまでの、カウント1つ分
  const C01 = '.method-region[data-method="c01"]';
  const C02 = '.method-region[data-method="c02"]';
  const Q = {
    c01Master: `${C01} [data-db-lane="master"] [data-db-row="${ITEM.id}"] td.cell-qty`,
    c01Slave: (i) => `${C01} [data-db-lane="slave${i}"] [data-db-row="${ITEM.id}"] td.cell-qty`,
    c01Slaves: `${C01} [data-db-lane^="slave"] [data-db-row="${ITEM.id}"] td.cell-qty`,
    c02Qty: `${C02} [data-db-lane="master"] [data-db-row="${ITEM.id}"] td.cell-qty`,
    c02Current: `${C02} [data-db-lane="master"] [data-db-row="${ITEM.id}"] td.cell-current-hash`,
    c02Stored: `${C02} [data-hash-lane="master"] [data-hash-row="${ITEM.id}"] td.cell-stored-hash`,
    c02SlaveQty: `${C02} [data-db-lane^="slave"] [data-db-row="${ITEM.id}"] td.cell-qty`,
    c02SlaveHash: `${C02} [data-hash-lane^="slave"] [data-hash-row="${ITEM.id}"] td.cell-stored-hash`,
  };
  /** VM(i+1) の台帳の、後ろから back 番目のブロック（1 が最新） */
  function lastBlock(i, back = 1) {
    const blocks = document.querySelectorAll(`#peerLane${i} .peer-rail > .block:not(.is-genesis)`);
    return blocks[blocks.length - back] || null;
  }
  /** ブロックの中の、ラベルが一致する行（「個数」の取引行、「ハッシュ」の行など）。labels は候補の配列でもよい */
  function blockRow(i, labels, sel = '.tx-row', back = 1) {
    const b = lastBlock(i, back);
    if (!b) return null;
    const list = Array.isArray(labels) ? labels : [labels];
    return Array.from(b.querySelectorAll(sel)).reverse().find((r) => {
      const k = r.querySelector('.k, .label');
      return k && list.includes(k.textContent.trim());
    }) || null;
  }
  const allQtyRows = () => [0, 1, 2].map((i) => blockRow(i, '個数'));
  const allBlocks = () => [0, 1, 2].map((i) => lastBlock(i));
  const stateRows = () => [0, 1, 2].map((i) => document.querySelector(`#peerLane${i} .couchdb .kv-row.is-item`));

  /** targets の1つは「要素・セレクタ・要素を返す関数」か、色だけ変えたいときの { t, tone } */
  function resolvePairs(targets, tone) {
    return (Array.isArray(targets) ? targets : [targets]).flatMap((t) => {
      if (t && typeof t === 'object' && !(t instanceof Element) && !Array.isArray(t) && 't' in t) return resolvePairs([t.t], t.tone || tone);
      const v = typeof t === 'function' ? t() : t;
      if (!v) return [];
      const els = typeof v === 'string' ? Array.from(document.querySelectorAll(v)) : (Array.isArray(v) ? v : [v]).filter(Boolean);
      return els.map((el) => ({ el, tone }));
    });
  }
  const resolveEls = (targets) => resolvePairs(targets).map((p) => p.el);

  const SPOT_CLASSES = ['scn-spot', 'is-info', 'is-ok', 'is-danger'];
  let spotNow = null; // { targets, tone, callout }
  // 強調した所以外を灰色で覆う。穴は強調した要素ごとに1つずつ開ける
  // （全体を1つの四角で囲むと、離れた所を光らせたときに関係ない所まで明るく残ってしまう）
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DIM_SIZE = 40000; // マップのどこへ寄せても覆えるだけの大きさ（マップ上の座標）
  function paintDim(els) {
    const world = $('mapWorld');
    if (!world) return;
    let svg = document.querySelector('.scn-dim');
    if (!svg) {
      svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'scn-dim');
      svg.setAttribute('width', DIM_SIZE);
      svg.setAttribute('height', DIM_SIZE);
      svg.innerHTML = `<defs><mask id="scnDimMask" maskUnits="userSpaceOnUse" x="0" y="0" width="${DIM_SIZE}" height="${DIM_SIZE}">
          <rect x="0" y="0" width="${DIM_SIZE}" height="${DIM_SIZE}" fill="#fff"/><g class="scn-dim-holes"></g></mask></defs>
        <rect x="0" y="0" width="${DIM_SIZE}" height="${DIM_SIZE}" fill="rgba(15, 23, 42, .4)" mask="url(#scnDimMask)"/>`;
      world.appendChild(svg);
    }
    const half = DIM_SIZE / 2;
    const pad = 8;
    const holes = els.map((el) => worldBox([el])).filter(Boolean).map((b) => `<rect x="${b.l - pad + half}" y="${b.t - pad + half}" width="${b.r - b.l + pad * 2}" height="${b.b - b.t + pad * 2}" rx="8" fill="#000"/>`).join('');
    const g = svg.querySelector('.scn-dim-holes');
    if (g.innerHTML !== holes) g.innerHTML = holes;
  }
  /** マップを描き直しても強調が消えないよう、短い間隔で付け直す */
  function paintSpot() {
    if (!spotNow) return;
    const pairs = resolvePairs(spotNow.targets);
    const els = pairs.map((p) => p.el);
    document.querySelectorAll('.scn-spot').forEach((el) => { if (!els.includes(el)) el.classList.remove(...SPOT_CLASSES); });
    pairs.forEach(({ el, tone }) => {
      const t = tone || spotNow.tone;
      el.classList.remove(...SPOT_CLASSES.filter((c) => c !== 'scn-spot' && c !== `is-${t}`));
      el.classList.add('scn-spot', `is-${t}`);
    });
    paintDim(els);
    if (spotNow.callout) placeCallout(spotNow.callout, els);
  }
  function clearSpot() {
    spotNow = null;
    document.querySelectorAll('.scn-spot').forEach((el) => el.classList.remove(...SPOT_CLASSES));
    document.querySelectorAll('.scn-dim, .scn-callout').forEach((el) => el.remove());
    // 強調の間に表の幅が変わっていても、帳票A・Bをつなぐ線を今の位置で描き直す
    if (typeof renderHashLinkOverlay === 'function') requestAnimationFrame(() => renderHashLinkOverlay());
  }

  /** 吹き出しを、強調した所の横（入らなければ上下）に置く */
  function placeCallout(co, els) {
    const rects = els.map((el) => el.getBoundingClientRect()).filter((r) => r.width || r.height);
    const stage = $('mapStage');
    if (!rects.length || !stage) return;
    const r = {
      l: Math.min(...rects.map((x) => x.left)), t: Math.min(...rects.map((x) => x.top)),
      r: Math.max(...rects.map((x) => x.right)), b: Math.max(...rects.map((x) => x.bottom)),
    };
    const sr = stage.getBoundingClientRect();
    const w = co.offsetWidth; const h = co.offsetHeight; const gap = 26;
    let side; let left; let top;
    if (r.r + gap + w <= sr.right - 8) { side = 'right'; left = r.r + gap; top = (r.t + r.b) / 2 - h / 2; }
    else if (r.l - gap - w >= sr.left + 8) { side = 'left'; left = r.l - gap - w; top = (r.t + r.b) / 2 - h / 2; }
    else if (r.b + gap + h <= sr.bottom - 8) { side = 'bottom'; top = r.b + gap; left = (r.l + r.r) / 2 - w / 2; }
    else { side = 'top'; top = r.t - gap - h; left = (r.l + r.r) / 2 - w / 2; }
    left = Math.max(sr.left + 8, Math.min(sr.right - w - 8, left));
    top = Math.max(sr.top + 8, Math.min(sr.bottom - h - 8, top));
    co.dataset.side = side;
    co.style.left = `${left}px`;
    co.style.top = `${top}px`;
    // 吹き出しの三角を、強調した所の中央に向ける
    if (side === 'left' || side === 'right') co.style.setProperty('--ay', `${Math.max(16, Math.min(h - 16, (r.t + r.b) / 2 - top))}px`);
    else co.style.setProperty('--ax', `${Math.max(16, Math.min(w - 16, (r.l + r.r) / 2 - left))}px`);
  }

  /** 吹き出しを出し、3・2・1 のあとに押せる「確認した」が押されるまで待つ */
  function callout(st, i, n) {
    return new Promise((resolve) => {
      const last = i === n - 1;
      const tone = st.tone || 'info';
      const co = document.createElement('div');
      co.className = `scn-callout is-${tone}`;
      co.setAttribute('role', 'dialog');
      co.innerHTML = `<div class="scn-co-step">${esc(st.kicker || '注目')}${n > 1 ? ` ${i + 1} / ${n}` : ''}</div>
        <div class="scn-co-title">${esc(st.title)}</div>
        <div class="scn-co-text">${st.text}</div>
        <button type="button" class="scn-btn scn-co-ok" disabled>3</button>`;
      document.body.appendChild(co);
      spotNow.callout = co;
      paintSpot();
      const btn = co.querySelector('.scn-co-ok');
      const label = st.ok || (last ? '確認した' : '確認した → 次へ');
      let count = 3;
      const timer = setInterval(() => {
        count -= 1;
        if (count > 0) { btn.textContent = String(count); return; }
        clearInterval(timer);
        btn.textContent = label;
        btn.disabled = false;
        btn.focus();
      }, COUNT_MS);
      const done = () => { if (btn.disabled) return; document.removeEventListener('keydown', onKey, true); resolve(); };
      const onKey = (e) => { if (e.key === 'Enter' && !btn.disabled) { e.preventDefault(); e.stopPropagation(); done(); } };
      btn.addEventListener('click', done);
      document.addEventListener('keydown', onKey, true);
    });
  }

  /**
   * stops: [{ targets, focus?, tone: 'info'|'ok'|'danger', kicker?, title, text(HTML), ok?, before?() }]
   * 1つずつ「寄せる → 光らせる → 吹き出し → 確認」を繰り返す。その間、パネルの操作は止める。
   */
  let spotChain = Promise.resolve();
  let spotPending = 0;
  function spot(stops) {
    // 呼んだ時点でパネルの操作を止め、前の説明が終わってから順に出す
    spotPending += 1;
    S.guiding = true;
    document.body.dataset.scnGuiding = '1';
    spotChain = spotChain.then(() => runSpot(stops)).catch((e) => console.error(e)).then(() => {
      spotPending -= 1;
      if (spotPending > 0) return;
      S.guiding = false;
      delete document.body.dataset.scnGuiding;
      renderPanel();
    });
    return spotChain;
  }
  async function runSpot(stops) {
    renderPanel();
    await sleep(250); // 直前の描き直しが落ち着くのを待つ
    for (let i = 0; i < stops.length; i++) {
      const st = stops[i];
      if (st.before) await st.before();
      const els = resolveEls(st.targets);
      if (!els.length) continue;
      spotNow = { targets: st.targets, tone: st.tone || 'info' };
      focusOn(st.focus ? resolveEls(st.focus) : els, { max: st.max ?? 1.25, pad: st.pad ?? 110 });
      paintSpot();
      const tick = setInterval(paintSpot, 250);
      await sleep(800);
      await callout(st, i, stops.length);
      clearInterval(tick);
      log('spot', { title: st.title });
      clearSpot();
    }
  }

  // ---------- 初期状態（毎回同じ状態から始める） ----------
  async function waitForBoot() {
    for (let i = 0; i < 60 && typeof liveModeState !== 'undefined' && liveModeState === 'loading'; i++) await sleep(250);
    if (typeof liveMode !== 'undefined' && liveMode) {
      // シナリオは模擬表示で進める（本物の記録・台帳には触れない）
      liveMode = false;
      if (typeof stopConnectionPolling === 'function') stopConnectionPolling();
      if (typeof pushLog === 'function') pushLog('シナリオ中は模擬表示（ブラウザ内のシミュレーション）で動きます', 'warn');
    }
  }

  function setupWorld() {
    if (typeof autoVerifyTimer !== 'undefined' && autoVerifyTimer) { clearTimeout(autoVerifyTimer); autoVerifyTimer = null; }
    reset();
    c01SlaveDbItems = null;
    if (IS_FAIL) {
      // サーバーの停止・起動はブラウザ内のシミュレーション（実機は止めない）
      mockFailureMode = true;
      mockNodeStates = [true, true, true];
    }
    if (document.body.dataset.compareView !== 'on') $('btnCompareView').click();
    $('newItemId').value = ITEM.id;
    $('newItemName').value = ITEM.name;
    $('newItemCategory').value = ITEM.category;
    $('newItemQuantity').value = String(ITEM.quantity);
    $('newItemLocation').value = ITEM.location;
    registerItem();
    if (autoVerifyTimer) { clearTimeout(autoVerifyTimer); autoVerifyTimer = null; }
    // シナリオB は、シナリオA の正規の更新（6台 → 5台）が済んだところから始める
    if (SCN === 'b') {
      commitUpdate(BASE_QTY, '廃棄');
      S.legit = { qty: BASE_QTY, reason: '廃棄' };
      peers.forEach((p) => p.blocks.forEach((b) => { b.isNew = false; }));
      peers.forEach((p) => Object.values(p.worldState).forEach((e) => { e.updated = false; }));
      Object.values(masterItems).forEach((it) => { it._updated = false; });
    }
    verifyDetails = [];
    comparisonVerified = false;
    S.audits = { single: null, hash: null, fabric: null };
    S.shown = null;
    clearMapFx();
    render(() => setTimeout(() => { drawRecordCard(); overview(); }, 150));
  }

  // ---------- 操作 ----------
  function item() { return masterItems[ITEM.id]; }

  /**
   * 申請どおりに更新する。db：記録（と複製・ハッシュ）を更新するか（記録のマシンが止まっていれば false）。
   * 台帳には、動いているノードで過半数の合意が取れたときだけブロックが追加される。
   */
  function commitUpdate(qty, reason, { db = true } = {}) {
    const it = item();
    const before = { ...it };
    const after = { ...before, quantity: qty, version: (before.version || 0) + 1 };
    if (db) {
      masterItems[ITEM.id] = { ...after, _updated: true, _tampered: false, _verify: null };
      syncLocalHashStore(masterItems[ITEM.id]);
      replicateToSlaves(ITEM.id);
      if (typeof replicateHashToSlaves === 'function') replicateHashToSlaves(ITEM.id);
    }
    comparisonVerified = false;
    verifyDetails = [];
    if (!canWriteMockLedger()) return { before, newBlocks: [] };
    const record = {
      logId: newLogId(),
      eventType: 'ITEM_UPDATE',
      targetId: ITEM.id,
      userId: 'staff@lab',
      orgId: 'Org1MSP',
      note: JSON.stringify({
        bf: hashItem(before),
        af: hashItem(after),
        reason,
        snap: { id: after.id, name: after.name, category: after.category, quantity: after.quantity, location: after.location, status: after.status },
      }),
      timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      status: 'ACTIVE',
    };
    const { newBlocks } = appendBlockToAllPeers(record, {
      [`ITEM-${ITEM.id}`]: { id: after.id, quantity: after.quantity, version: after.version, af: hashItem(after) },
    });
    if (typeof hideChangeSpotlight === 'function') hideChangeSpotlight(); // 変化は吹き出しで見せる
    return { before, newBlocks };
  }

  // ---------- ブロックの伝播（受け付けたノード → ほかのノード） ----------
  // 台帳のデータは一度に全ノードへ追加されるので、まだ届いていないノードのブロックは画面上だけ隠しておき、
  // 受け付けたノードから粒が飛んで届いたところで見せる（自動で同期する様子）
  const blockKey = (peerIndex, num) => `${peers[peerIndex].id}-${num}`;
  const blockSel = (key) => `[data-block="${key}"]`;
  function applyPending() {
    document.querySelectorAll('.scn-pending').forEach((el) => el.classList.remove('scn-pending'));
    S.pending.forEach((key) => {
      const el = key.startsWith('couch-')
        ? document.querySelector(`#peerLane${key.slice(6)} .couchdb .kv-row.is-item`)
        : document.querySelector(blockSel(key));
      if (el) el.classList.add('scn-pending');
    });
  }
  /** VM(i+1) のブロック #num と状態DB を「まだ届いていない」にする */
  function hold(i, nums) {
    if (!nums.length) return;
    nums.forEach((n) => S.pending.add(blockKey(i, n)));
    S.pending.add(`couch-${i}`);
  }
  /** from のブロックから、VM(i+1) の同じ番号のブロックへ届ける（届いたら見せる） */
  function deliver(fromKey, list) {
    return Promise.all(list.map(({ i, num }) => new Promise((resolve) => {
      const to = blockKey(i, num);
      const done = () => { S.pending.delete(to); S.pending.delete(`couch-${i}`); applyPending(); resolve(); };
      if (typeof spawnParticle === 'function') spawnParticle(blockSel(fromKey), blockSel(to), 'ok', done);
      else done();
    }))).then(() => sleep(300));
  }
  /**
   * 申請でブロックが追加されたときの見せ方。newBlocks の先頭（動いている中で最初のノード）が受け付けて追記し、
   * ほかの動いているノードへ伝わる。止まっているノードには届かない。
   */
  function propagationStops(newBlocks, k) {
    if (!newBlocks.length) return [];
    const idx = (b) => peers.findIndex((p) => p.id === b.peerId);
    const recv = idx(newBlocks[0]);
    const num = newBlocks[0].blockNum;
    const others = newBlocks.slice(1).map((b) => ({ i: idx(b), num: b.blockNum }));
    const from = blockKey(recv, num);
    const names = others.map((o) => `VM${o.i + 1}`).join('・');
    const down = [0, 1, 2].filter((i) => !newBlocks.some((b) => idx(b) === i));
    const stops = [{
      tone: 'ok', kicker: k, targets: [() => lastBlock(recv)], focus: [allBlocks], pad: 60,
      title: `VM${recv + 1} が受け付けて、ブロック #${num} を追記`,
      text: `${down.includes(0) ? 'VM1 は止まっているので、動いている ' : ''}<b>VM${recv + 1}</b> のノードが申請を受け付け、取引をまとめたブロック #${num} を台帳の最後に<b>追記</b>しました。前のブロックは消えずに残ります。${others.length ? `${names} には、まだ届いていません。` : ''}`,
    }];
    if (others.length) {
      stops.push({
        tone: 'ok', kicker: k, before: () => deliver(from, others), targets: [() => others.map((o) => lastBlock(o.i)), () => lastBlock(recv)], focus: [allBlocks], pad: 60,
        title: `${names} へ伝わった`,
        text: `VM${recv + 1} は新しいブロックを ${names} に送りました。受け取ったノードも、自分の台帳の最後に同じブロックを追記します。こうして、動いているノードの台帳が<b>自動で同期</b>されます。`,
      });
    }
    return stops;
  }

  // ---------- シナリオA：正規の更新 ----------
  /** 申請フォームから。数値が変わり、付随する情報（複製・ハッシュ・ブロック）がそろって更新される様子を順に見せる */
  async function legitUpdate(qty, reason) {
    if (!item() || S.legit) return;
    const { before, newBlocks } = commitUpdate(qty, reason);
    // ブロックは VM1 が受け付けて追記し、VM2・VM3 へ伝わる。伝わるまでは VM2・VM3 のブロックを隠す
    newBlocks.slice(1).forEach((nb) => hold(peers.findIndex((p) => p.id === nb.peerId), [nb.blockNum]));
    S.legit = { qty, reason };
    S.phase = 1;
    log('legit', { qty, reason });
    const num = newBlocks.length ? newBlocks[0].blockNum : '';
    const from = before.quantity;
    const k = '正規の更新';
    render();
    await spot([
      // 単一DB
      { tone: 'ok', kicker: k, targets: [Q.c01Master], focus: [C01], title: '単一DB：記録の個数が変わった', text: `マシン1の記録が <b>${from}台 → ${qty}台</b> になりました。申請で変わるのは、この数値です。` },
      { tone: 'ok', kicker: k, targets: [Q.c01Slaves], focus: [C01], title: '単一DB：複製にも写った', text: `マシン2・3 は、記録を自動で写す<b>複製</b>です。同じ <b>${qty}台</b> が写りました。単一DBで一緒に変わるのは、これだけです。` },
      // DB＋ハッシュ
      { tone: 'ok', kicker: k, targets: [Q.c02Qty], focus: [C02], title: 'DB＋ハッシュ：記録の個数が変わった', text: `帳票A（備品データ）の個数が <b>${from}台 → ${qty}台</b> になりました。` },
      { tone: 'ok', kicker: k, targets: [Q.c02Current], focus: [C02], title: '「いまの値」が計算し直された', text: '「いまの値」は、記録の中身から計算したハッシュです。個数が変わったので、<b>まったく別の値</b>になりました。' },
      { tone: 'ok', kicker: k, targets: [Q.c02Stored, Q.c02Current], focus: [C02], title: '「保存した値」も新しいハッシュに', text: '正規の手続きでは、更新と同時にハッシュを計算して、帳票B に<b>保存し直します</b>。「いまの値」と「保存した値」がそろっています。' },
      { tone: 'ok', kicker: k, targets: [Q.c02SlaveQty, Q.c02SlaveHash], focus: [C02], title: 'DB＋ハッシュ：複製にも写った', text: `マシン2・3 にも、新しい個数（${qty}台）と保存した値が写りました。` },
      // ブロックチェーン
      ...propagationStops(newBlocks, k),
      { tone: 'ok', kicker: k, targets: [allBlocks], focus: [allBlocks], pad: 60, title: `3台の台帳がそろった：ブロック #${num}`, text: `VM1〜VM3 の台帳に、同じブロック #${num} が追記されました。DB の複製は記録から一方向に写すだけですが、ブロックチェーンでは<b>受け付けたノードから、ほかのノードへ伝わって</b>そろいます。` },
      { tone: 'ok', kicker: k, targets: [allQtyRows], focus: [allBlocks], pad: 60, title: 'ブロックの中身：更新後の個数', text: `ブロック #${num} には、更新後の個数 <b>${qty}台</b> と、操作の種類（${esc(reason)}による更新）が入っています。` },
      { tone: 'ok', kicker: k, targets: [() => blockRow(0, '前のハッシュ', '.hash-line'), () => blockRow(0, 'ハッシュ', '.hash-line', 2)], focus: [() => [lastBlock(0), lastBlock(0, 2)]], max: 1.5, title: 'ブロックは「前のハッシュ」でつながる', text: `ブロック #${num} の「前のハッシュ」は、ひとつ前のブロックの「ハッシュ」と同じ値です。こうして、ブロックが鎖のようにつながります。` },
      { tone: 'ok', kicker: k, targets: [stateRows], focus: [stateRows], pad: 60, title: '状態DB：いまの個数', text: `状態DB は、台帳をたどった結果の<b>いまの値</b>を持っています。3台とも <b>${qty}台</b> になりました。` },
      { tone: 'ok', kicker: k, targets: ['.scn-record'], focus: ['#peerLane0', '.scn-record'], pad: 60, title: '記録（VM1 のデータベース）', text: `ブロックチェーン方式でも、ふだん使う記録は <b>${qty}台</b> になっています。チェックでは、この記録を3台の台帳と見比べます。` },
    ]);
    S.phase = 2;
    renderPanel();
  }

  // ---------- シナリオB：マルウェアによる書換え ----------
  /** 正規の手続きを踏まずに、記録の中の「5」だけを探し出して「3」に書き換える */
  async function runMalware() {
    const it = item();
    if (!it || S.phase !== 0) return;
    const before = it.quantity;
    it.quantity = TAMPERED_QTY;
    it._tampered = true;
    it._tamperedFromQty = before;
    it._updated = true;
    it._verify = null;
    comparisonVerified = false;
    verifyDetails = [];
    log('malware', { from: before, to: TAMPERED_QTY });
    render();
    const k = 'マルウェア';
    await spot([
      { tone: 'danger', kicker: k, targets: [Q.c01Master], focus: [C01], title: '単一DB：記録の数値だけが書き換わった', text: `マルウェアが、申請を通さずに、マシン1の記録の中から <b>${before}</b> を探し出して <b>${TAMPERED_QTY}</b> に書き換えました。` },
      { tone: 'danger', kicker: k, targets: [Q.c02Qty], focus: [C02], title: 'DB＋ハッシュ：記録の数値だけが書き換わった', text: `帳票A の個数も <b>${before}台 → ${TAMPERED_QTY}台</b>。` },
      { tone: 'info', kicker: k, targets: [Q.c02Stored], focus: [C02], title: '「保存した値」はそのまま', text: `正規の手続きを通っていないので、ハッシュは計算し直されていません。保存した値は、<b>${before}台のときのハッシュ</b>のままです。` },
      { tone: 'danger', kicker: k, targets: ['.scn-record'], focus: ['#peerLane0', '.scn-record'], pad: 60, title: 'ブロックチェーン：VM1 の記録が書き換わった', text: `VM1 のデータベースの記録も <b>${before}台 → ${TAMPERED_QTY}台</b> に書き換わりました。` },
      { tone: 'info', kicker: k, targets: [allQtyRows], focus: [allBlocks], pad: 60, title: '台帳（ブロック）はそのまま', text: `取引として申請されていないので、新しいブロックは追加されていません。3台の台帳に残っている最新の個数は <b>${before}台</b> のままです。` },
    ]);
    S.phase = 2;
    renderPanel();
  }

  /** 単一DB：記録の変更が、そのまま複製へ自動で写る */
  async function replicateSingle() {
    if (S.phase !== 2) return;
    c01SlaveDbItems = slaveDbItems.map((s) => ({ ...s, [ITEM.id]: snapshotForReplication(item()) }));
    log('replicate-single');
    render(() => c01SlaveDbItems.forEach((_, idx) => spawnParticle(
      `${C01} [data-db-lane="master"] [data-db-row="${ITEM.id}"]`,
      `${C01} [data-db-lane="slave${idx}"] [data-db-row="${ITEM.id}"]`,
      'danger',
    )));
    await sleep(500);
    await spot([
      { tone: 'danger', kicker: '単一DB', targets: [Q.c01Slaves], focus: [C01], title: '書き換えた値が、複製にもそのまま写った', text: `複製は、記録が正しいかどうかを確かめずに写します。マシン2・3 も <b>${TAMPERED_QTY}台</b> になりました。` },
    ]);
    S.phase = 3;
    renderPanel();
  }

  /** DB＋ハッシュ：照合が合わないので、複製の前に止める */
  async function hashStop() {
    await spot([
      { tone: 'ok', kicker: 'DB＋ハッシュ', targets: [Q.c02SlaveQty, Q.c02SlaveHash], focus: [C02], title: '複製の前に止めた', text: `照合が合わないので、書き換わった記録は複製へ写しません。マシン2・3 は <b>${BASE_QTY}台</b> のままです。` },
      { tone: 'danger', kicker: 'DB＋ハッシュ', targets: [Q.c02Qty], focus: [C02], title: 'トラブルが起きたことは分かる', text: '正規の手続きを通らずに、記録が書き換わったことが分かります。この記録をもとにした更新は止めて、原因を調べられます。' },
    ]);
  }

  /** ブロックチェーン：ほかのノードの台帳と照合して、VM1 の記録が狂ったと分かる */
  async function fabricStop() {
    await spot([
      { tone: 'danger', kicker: 'ブロックチェーン', targets: ['.scn-record'], focus: ['#peerLane0', '.scn-record'], pad: 60, title: 'VM1 の記録が狂ったと分かる', text: `VM1 の記録（${TAMPERED_QTY}台）は、VM1〜VM3 の台帳に残る履歴（${BASE_QTY}台）と合いません。正規の手続きを通らずに書き換わったと分かるので、この記録をもとにした更新は止めます。` },
      { tone: 'ok', kicker: 'ブロックチェーン', targets: [allQtyRows], focus: [allBlocks], pad: 60, title: '正しい値は台帳に残っている', text: `台帳は VM2・VM3 も持っているので、VM1 の記録が書き換わっても、正規の更新の値（<b>${BASE_QTY}台</b>）を確かめられます。` },
    ]);
  }

  // ---------- シナリオC・D：サーバーの故障 ----------
  const vmName = (list) => list.map((i) => `VM${i + 1}`).join('・');
  const vmCards = (i) => `.method-region [data-machine="${VM_KEYS[i]}"]`;
  /** 止まっているサーバーに載っているマシン（単一DB・DB＋ハッシュ）を灰色にする */
  function paintDown() {
    if (!IS_FAIL) return;
    VM_KEYS.forEach((key, i) => {
      document.querySelectorAll(`.method-region [data-machine="${key}"]`).forEach((el) => el.classList.toggle('scn-down', mockNodeStates[i] === false));
    });
  }
  function setVm(i, up) {
    setMockNodeState(i, up);
    if (typeof hideChangeSpotlight === 'function') hideChangeSpotlight(); // 変化は吹き出しで見せる
    paintDown();
  }

  async function stopVms() {
    STOP_LIST.forEach((i) => setVm(i, false));
    S.phase = 1;
    log('stop', { vms: vmName(STOP_LIST) });
    renderPanel();
    const names = vmName(STOP_LIST);
    const up = [0, 1, 2].filter((i) => mockNodeStates[i]);
    await spot([
      {
        tone: 'danger', kicker: '故障', targets: STOP_LIST.map(vmCards), focus: ['.method-region'], max: 1,
        title: `単一DB・DB＋ハッシュ：${names} が止まった`,
        text: SCN === 'c'
          ? 'VM1 には、申請を受け付ける<b>記録（マシン1）</b>が載っています。'
          : 'VM1 の<b>記録（マシン1）</b>と、VM2 の複製（マシン2）が止まりました。',
      },
      {
        tone: 'danger', kicker: '故障', targets: STOP_LIST.map((i) => `#peerLane${i}`), focus: FOCUS.fabric,
        title: `ブロックチェーン：${names} のノードが止まった`,
        text: `止まったノードの台帳には、新しいブロックが届かなくなります。動いているのは <b>${vmName(up)} の${up.length}台</b>です。`,
      },
    ]);
  }

  /** 更新の申請を出す。各方式で受け付けられたかを1つずつ見せる */
  async function attemptWrite() {
    const dbUp = mockNodeStates[0] !== false;
    const up = [0, 1, 2].filter((i) => mockNodeStates[i]);
    const downList = [0, 1, 2].filter((i) => !mockNodeStates[i]);
    const ledgerOk = canWriteMockLedger();
    const { before, newBlocks } = commitUpdate(BASE_QTY, '廃棄', { db: dbUp });
    // 受け付けたノード（動いている中で最初のノード）以外のブロックは、伝わるまで隠す
    newBlocks.slice(1).forEach((nb) => hold(peers.findIndex((p) => p.id === nb.peerId), [nb.blockNum]));
    const res = { at: new Date().toISOString(), down: vmName(downList), db: dbUp, ledger: ledgerOk };
    S.tries.push(res);
    log('write', res);
    S.phase += 1;
    render();
    renderPanel();
    const k = '申請の結果';
    const num = newBlocks.length ? newBlocks[0].blockNum : '';
    const stops = [];
    if (dbUp) {
      stops.push({ tone: 'ok', kicker: k, targets: [Q.c01Master, Q.c02Qty], focus: ['.method-region'], max: 1, title: '単一DB・DB＋ハッシュ：受け付けた', text: `記録が ${before.quantity}台 → <b>${BASE_QTY}台</b> になりました。` });
      stops.push({ tone: 'ok', kicker: k, targets: [Q.c01Slaves, Q.c02SlaveQty], focus: ['.method-region'], max: 1, title: '複製にも写った', text: `マシン2・3 にも <b>${BASE_QTY}台</b> が写りました。` });
    } else {
      stops.push({
        tone: 'danger', kicker: k, targets: [`${C01} [data-machine="master"]`, `${C02} [data-machine="master"]`], focus: ['.method-region'], max: 1,
        title: '単一DB・DB＋ハッシュ：受け付けられない',
        text: '申請を受け付けるのは<b>記録（マシン1）だけ</b>です。複製（マシン2・3）は記録を写してバックアップを取るだけで、代わりには受け付けません。<b>VM1 が止まっている限り、受付はできません</b>。',
      });
    }
    if (ledgerOk) {
      stops.push(...propagationStops(newBlocks, k));
      if (downList.length) {
        stops.push({ tone: 'danger', kicker: k, targets: downList.map((i) => () => lastBlock(i)), focus: [allBlocks], pad: 60, title: `${vmName(downList)} には届かない`, text: `止まっている ${vmName(downList)} の台帳には、ブロック #${num} が届いていません。それでも、<b>どれかのノードが動いていれば、申請は受け付けられます</b>。` });
      }
    } else {
      stops.push({
        tone: 'danger', kicker: k, targets: [0, 1, 2].map((i) => `#peerLane${i}`), focus: FOCUS.fabric,
        title: 'ブロックチェーン：書き込めない',
        text: `動いているのは <b>${vmName(up)} の${up.length}台だけ</b>。台帳を読むことはできますが、ブロックを追加するには<b>3台中2台以上（過半数）の合意</b>が必要なので、書き込めません（読み込みのみ）。`,
      });
    }
    await spot(stops);
  }

  async function restartVms() {
    const before = STOP_LIST.map((i) => peers[i].blocks.length);
    // 止まっている間のブロックは、動いていたノードから届く。届くまでは隠しておく
    const src = [0, 1, 2].filter((i) => !STOP_LIST.includes(i) && mockNodeStates[i]).sort((x, y) => peers[y].blocks.length - peers[x].blocks.length)[0];
    const srcLen = src === undefined ? 0 : peers[src].blocks.length;
    const missing = STOP_LIST.flatMap((i, n) => Array.from({ length: Math.max(0, srcLen - before[n]) }, (_, x) => ({ i, num: before[n] + x })));
    STOP_LIST.forEach((i) => hold(i, missing.filter((m) => m.i === i).map((m) => m.num)));
    STOP_LIST.forEach((i) => setVm(i, true));
    const synced = STOP_LIST.map((i, n) => peers[i].blocks.length - before[n]);
    S.phase += 1;
    log('restart', { vms: vmName(STOP_LIST), synced });
    renderPanel();
    const names = vmName(STOP_LIST);
    const k = '復帰';
    const lost = S.tries.length && !S.tries[S.tries.length - 1].db;
    const stops = [];
    stops.push(synced.some((x) => x > 0)
      ? {
        tone: 'ok', kicker: k, targets: STOP_LIST.map((i) => () => lastBlock(i)), focus: [allBlocks], pad: 60,
        before: () => Promise.all(missing.map((m) => deliver(blockKey(src, m.num), [m]))),
        title: `ブロックチェーン：${names} が追いついた`,
        text: `${names} は、動いていた <b>VM${src + 1}</b> から<b>止まっている間のブロック</b>を受け取り、自分の台帳に追記しました。3台の台帳がそろっています。`,
      }
      : { tone: 'info', kicker: k, targets: STOP_LIST.map((i) => `#peerLane${i}`), focus: FOCUS.fabric, title: `ブロックチェーン：${names} が動き出した`, text: '止まっている間に追加されたブロックはないので、受け取るものはありません。申請は書き込まれないままです。' });
    stops.push(lost
      ? { tone: 'danger', kicker: k, targets: [Q.c01Master, Q.c02Qty], focus: ['.method-region'], max: 1, title: '単一DB・DB＋ハッシュ：申請は消えたまま', text: `マシン1 は動き出しましたが、記録は <b>${item().quantity}台</b> のまま。止まっている間の申請はどこにも残っていないので、出し直す必要があります。` }
      : { tone: 'ok', kicker: k, targets: [`${C01} [data-machine="master"]`, `${C02} [data-machine="master"]`], focus: ['.method-region'], max: 1, title: '単一DB・DB＋ハッシュ：動き出した', text: 'マシンは動き出しました。' });
    await spot(stops);
  }

  // ---------- チェック ----------
  function latestQty(peer) {
    const snap = findLatestLedgerSnapshot(peer, ITEM.id);
    return snap ? Number(snap.quantity) : null;
  }

  /** 方式ごとのチェック。ブロックチェーンは3台の台帳の多数派の値を記録と比べる */
  function auditOf(id) {
    const it = item();
    const q = Number(it.quantity);
    const tampered = Boolean(it._tampered);
    if (id === 'single') {
      const slaves = c01SlaveDbItems || slaveDbItems;
      const rows = slaves.map((s, i) => {
        const v = Number(s[ITEM.id]?.quantity);
        return { text: `記録 ${q}台 ⇄ 複製（マシン${i + 2}） ${v}台`, ok: v === q };
      });
      return { tampered, rows, found: rows.some((r) => !r.ok) };
    }
    if (id === 'hash') {
      const stored = localHashStore[ITEM.id]?.hash || '';
      const current = hashItem(it);
      const rows = [{ text: `いまの値（${q}台から計算） ${current.slice(0, 6)}… ⇄ 保存した値 ${stored.slice(0, 6)}…`, ok: stored === current }];
      return { tampered, rows, found: rows.some((r) => !r.ok) };
    }
    const vals = peers.map((p) => latestQty(p));
    const counts = {};
    vals.forEach((v) => { counts[v] = (counts[v] || 0) + 1; });
    const majority = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
    const rows = vals.map((v, i) => ({ text: `VM${i + 1} の台帳 ${v}台`, ok: v === majority, lane: i, minority: v !== majority }));
    rows.push({ text: `台帳の値 ${majority}台 ⇄ VM1 の記録 ${q}台`, ok: majority === q, summary: true });
    return { tampered, rows, found: majority !== q, majority };
  }

  function clearMapFx() {
    document.querySelectorAll('.scn-alarm').forEach((el) => el.classList.remove('scn-alarm'));
  }

  /** チェックの結果の説明（吹き出しの最後に出す） */
  function auditWhy(id, res) {
    if (!res.tampered) return '記録と照合の手がかりに、食い違いはありません。';
    if (id === 'single') return `複製は記録をそのまま写すので、書き換わった ${TAMPERED_QTY}台 も写っていました。食い違いが出ないので、書き換えに気付けません。`;
    if (id === 'hash') {
      return res.found
        ? `保存した値は、正規の更新（${BASE_QTY}台）のときに計算したものです。いまの記録（${TAMPERED_QTY}台）から計算した値と合わないので、書き換えに気付けました。`
        : '「いまの値」と「保存した値」が一致したので、食い違いは見つかりませんでした。';
    }
    if (!res.found) return `台帳の値（${res.majority}台）と記録が一致したので、食い違いは見つかりませんでした。`;
    return `3台の台帳はどれも ${res.majority}台（正規の更新の履歴）。VM1 の記録の ${TAMPERED_QTY}台 と食い違ったので、書き換えに気付けました。`;
  }

  async function runAudit(id) {
    if (S.auditing || S.guiding) return;
    S.auditing = true;
    clearMapFx();
    const res = auditOf(id);
    S.audits[id] = res;
    S.shown = { id, rows: [], stamp: false };
    const trial = { at: new Date().toISOString(), method: id, found: res.found };
    S.trials.push(trial);
    log('audit', trial);
    renderPanel();

    // 見比べる2か所を1組ずつ光らせ、結果を確認してから次の組へ進む
    const k = 'チェック';
    const push = (r) => async () => { S.shown.rows.push(r); renderPanel(); };
    const mark = (ok) => `<span class="scn-co-mark ${ok ? 'is-ok' : 'is-ng'}">${ok ? '一致' : '不一致'}</span>`;
    let stops;
    if (id === 'single') {
      stops = res.rows.map((r, i) => ({ tone: r.ok ? 'info' : 'danger', kicker: k, before: push(r), targets: [Q.c01Master, Q.c01Slave(i)], focus: [C01], title: `記録 ⇄ 複製（マシン${i + 2}）`, text: `${esc(r.text)} ${mark(r.ok)}` }));
    } else if (id === 'hash') {
      stops = res.rows.map((r) => ({ tone: r.ok ? 'info' : 'danger', kicker: k, before: push(r), targets: [Q.c02Current, { t: Q.c02Stored, tone: 'info' }], focus: [C02], title: 'いまの値 ⇄ 保存した値', text: `${esc(r.text)} ${mark(r.ok)}` }));
    } else {
      stops = res.rows.map((r) => (r.summary
        ? { tone: r.ok ? 'info' : 'danger', kicker: k, before: push(r), targets: [{ t: allQtyRows, tone: 'info' }, '.scn-record'], focus: FOCUS.fabric, title: '台帳の値 ⇄ VM1 の記録', text: `${esc(r.text)} ${mark(r.ok)}` }
        : { tone: r.minority ? 'danger' : 'info', kicker: k, before: push(r), targets: [() => blockRow(r.lane, '個数')], focus: [`#peerLane${r.lane}`], title: `VM${r.lane + 1} の台帳`, text: `最新のブロックの個数は <b>${latestQty(peers[r.lane])}台</b>。${r.minority ? 'ほかの2台と食い違っています（少数派）。' : ''}` }));
    }
    const region = id === 'fabric' ? FOCUS.fabric : [id === 'single' ? C01 : C02];
    // 結果も、見比べた所を光らせる（方式全体を囲むと吹き出しの置き場がなくなる）
    const compared = {
      single: [Q.c01Master, Q.c01Slaves],
      hash: [Q.c02Current, { t: Q.c02Stored, tone: 'info' }],
      fabric: [{ t: allQtyRows, tone: 'info' }, '.scn-record'],
    }[id];
    const stampText = !res.tampered ? '書き換えなし' : (res.found ? '書き換えに気付けた' : '書き換えに気付けない');
    stops.push({
      tone: res.found ? 'danger' : 'info',
      kicker: '結果',
      before: async () => {
        S.shown.stamp = true;
        // マップ側の判定（各方式の見出し・ブロックの色）も更新する
        if (typeof verifyAll === 'function') await verifyAll();
        // verifyAll は照合結果を上部に出すので消す（結果は吹き出しで見せる）
        if (typeof hideChangeSpotlight === 'function') hideChangeSpotlight();
        renderPanel();
      },
      targets: compared,
      focus: region,
      max: 1,
      title: stampText,
      text: auditWhy(id, res),
    });
    await spot(stops);
    S.auditing = false;
    renderPanel();
  }

  /** シナリオB：方式ごとのチェックと、その後の止め方 */
  async function tamperCheck(id) {
    await runAudit(id);
    if (id === 'hash') await hashStop();
    if (id === 'fabric') await fabricStop();
    S.phase += 1;
    renderPanel();
  }

  // ---------- 右パネル ----------
  function stampHtml(res) {
    if (!res.tampered) return '<span class="scn-stamp is-none">書き換えなし</span>';
    return res.found ? '<span class="scn-stamp is-found">気付けた</span>' : '<span class="scn-stamp is-missed">気付けない</span>';
  }
  function rowsHtml(id) {
    if (!S.shown || S.shown.id !== id) return '';
    const res = S.audits[id];
    const rows = S.shown.rows.map((x) => {
      let mark;
      if (id === 'fabric' && !x.summary) mark = x.minority ? '少数派' : '多数派';
      else mark = x.ok ? '一致' : '不一致';
      const cls = id === 'fabric' && !x.summary ? (x.minority ? 'is-ng' : 'is-ok') : (x.ok ? 'is-ok' : 'is-ng');
      return `<div class="scn-res-row ${cls} ${x.summary ? 'is-summary' : ''}"><span>${esc(x.text)}</span><span class="m">${mark}</span></div>`;
    }).join('');
    return `<div class="scn-res"><div class="scn-res-head"><span>チェックの結果</span>${S.shown.stamp ? stampHtml(res) : ''}</div>${rows}</div>`;
  }

  function renderSteps(cur) {
    const el = $('scnSteps');
    if (!el) return;
    el.innerHTML = STEPS.map((s, i) => `<li class="${i < cur ? 'is-done' : i === cur ? 'is-now' : ''}">${i + 1}. ${s}</li>`).join('');
  }
  const subList = (subs, cur) => `<ol class="scn-sub">${subs.map((x, i) => `<li class="${i < cur ? 'is-done' : i === cur ? 'is-now' : ''}">${x}</li>`).join('')}</ol>`;
  // 吹き出しで確認している間は、いまの段階を表示したまま
  const shownPhase = () => (S.guiding && S.phase > 0 ? S.phase - 1 : S.phase);

  function updatePanel() {
    let h = subList(['申請する', '変化を確かめる', 'まとめ'], S.phase);
    if (S.phase === 0) {
      h += `<h2>正規の手続きで更新する</h2>
        <p>昨日、${ITEM.name}が1台壊れて廃棄されました。決められた手続き（更新の申請）で、記録を <b>${BASE_QTY}台</b> に直します。</p>
        <form class="scn-form" id="scnForm" onsubmit="return false">
          <div class="scn-form-title">備品の更新申請</div>
          <label>備品<input type="text" value="${ITEM.id} ${ITEM.name}" disabled></label>
          <label>個数<input type="number" id="scnFormQty" min="0" step="1" value="${ITEM.quantity}"></label>
          <label>理由<select id="scnFormReason">
            <option value="">選んでください</option>
            ${['廃棄', '貸出', '返却', '購入'].map((r) => `<option>${r}</option>`).join('')}
          </select></label>
          <label>申請者<input type="text" value="研究室（あなた）" disabled></label>
          <div class="scn-ed-msg" id="scnFormMsg"></div>
          <button type="button" class="scn-btn" data-apply>申請する</button>
        </form>`;
    } else if (S.phase === 1) {
      h += `<h2>変化を確かめる</h2>
        <p>申請が通りました。3つの方式で、<b>数値</b>と、それに付随する<b>情報</b>がどう更新されたかを、1か所ずつ見ていきます。</p>
        ${legendHtml()}`;
    } else {
      h += summaryHtml();
    }
    return h;
  }

  function tamperPanel() {
    // 段階は吹き出しを確認し終えてから進める（確認している間は、いまの段階を表示したまま）
    // 0:マルウェア 2:単一DB 複製 3:単一DB チェック 4:DB＋ハッシュ 5:ブロックチェーン 6:まとめ
    const P = S.phase;
    const subIdx = P <= 1 ? 0 : P <= 3 ? 1 : P === 4 ? 2 : P === 5 ? 3 : 4;
    let h = subList(['書き換わる', '単一DB', 'DB＋ハッシュ', 'ブロックチェーン', 'まとめ'], subIdx);
    const busy = S.auditing || S.guiding;
    const btn = (attr, label) => `<button type="button" class="scn-btn" ${attr} ${busy ? 'disabled' : ''}>${busy ? '確認中…' : label}</button>`;
    if (P <= 1) {
      h += `<h2>マルウェアが値を書き換える</h2>
        <p>シナリオA で、正規の手続きにより ${ITEM.name}は <b>${BASE_QTY}台</b> に更新されました。</p>
        <p>ここで、<b>VM1 がマルウェアに感染</b>しました。マルウェアは<b>正規の手続きを踏まずに</b>、データの中から「${BASE_QTY}」という値を探し出して、<b>${TAMPERED_QTY}</b> に直接書き換えます。</p>
        <div class="scn-note">申請を通らないので、付随する情報（ハッシュ・ブロック）は更新されません。</div>
        ${btn('data-act="malware"', 'マルウェアを動かす')}`;
    } else if (P === 2) {
      h += `<h2>単一DB：複製はどうなる？</h2>
        <p>単一DB では、記録が変わると、複製（マシン2・3）へ<b>自動で写されます</b>。</p>
        ${btn('data-act="replicate"', '複製の様子を見る')}`;
    } else if (P === 3) {
      h += `<h2>単一DB：チェックする</h2>
        <p>記録と複製を見比べて、書き換えに気付けるか確かめます。</p>
        ${btn('data-act="check-single"', 'チェックする')}
        ${rowsHtml('single')}`;
    } else if (P === 4) {
      h += `${S.audits.single ? `<div class="scn-note">単一DB：書き換わった値がそのまま複製されました。</div>` : ''}
        <h2>DB＋ハッシュ：複製する前に照合する</h2>
        <p>DB＋ハッシュでは、複製する前に、記録から計算した<b>「いまの値」</b>と、正規の更新のときに保存した<b>「保存した値」</b>を照合します。</p>
        ${btn('data-act="check-hash"', '照合してから複製する')}
        ${rowsHtml('hash')}`;
    } else if (P === 5) {
      h += `<div class="scn-note">DB＋ハッシュ：照合が合わず、複製の前に止まりました。</div>
        <h2>ブロックチェーン：ほかのノードと照合する</h2>
        <p>ブロックチェーンでは、VM1 の記録を、<b>VM1〜VM3 のノードが持つ台帳</b>と照合します。</p>
        ${btn('data-act="check-fabric"', 'チェックする')}
        ${rowsHtml('fabric')}`;
    } else {
      h += summaryHtml();
    }
    return h;
  }

  /** シナリオC・D の右パネル */
  function failPanel() {
    const names = vmName(STOP_LIST);
    const subs = SCN === 'c' ? ['止める', '申請する', '動かす'] : ['止める', '申請する', '動かす', 'もう一度申請'];
    const P = shownPhase();
    let h = subList(subs, P);
    const form = (again) => `<div class="scn-form">
        <div class="scn-form-title">備品の更新申請${again ? '（出し直し）' : ''}</div>
        <label>備品<input type="text" value="${ITEM.id} ${ITEM.name}" disabled></label>
        <label>個数<input type="text" value="${ITEM.quantity}台 → ${BASE_QTY}台" disabled></label>
        <label>理由<input type="text" value="廃棄" disabled></label>
        <button type="button" class="scn-btn" data-act="write">申請する</button>
      </div>`;
    if (P === 0) {
      h += `<h2>${names} を止める</h2>
        <p>3台のサーバー（VM1〜VM3）のうち、<b>${names}</b> が故障で止まった、という状況をつくります。</p>
        <div class="scn-note">VM1 には、単一DB・DB＋ハッシュの<b>記録（マシン1）</b>と、ブロックチェーンの VM1 のノードが載っています。${SCN === 'd' ? 'VM2 には、複製（マシン2）と VM2 のノードが載っています。' : ''}</div>
        <button type="button" class="scn-btn" data-act="stop">${names} を止める</button>`;
    } else if (P === 1) {
      h += `<h2>申請してみる</h2>
        <p>${names} が止まっている間に、${ITEM.name}が1台壊れて廃棄されました。更新の申請を出して、各方式で受け付けられるか確かめます。</p>
        ${form(false)}`;
    } else if (P === 2) {
      h += `<h2>${names} を動かす</h2>
        <p>修理が終わり、${names} が動き出します。止まっている間のことが、どうなるか見てみましょう。</p>
        <button type="button" class="scn-btn" data-act="restart">${names} を動かす</button>`;
    } else if (SCN === 'd' && P === 3) {
      h += `<h2>もう一度申請する</h2>
        <p>3台とも動いているので、同じ申請を出し直します。</p>
        ${form(true)}`;
    } else {
      h += summaryHtml();
    }
    return h;
  }

  /** 体験を終えたあとのまとめ（右パネルに出す） */
  // [方式, 理由, 結果, 強調するか]
  const SUMMARY = {
    a: {
      rows: [
        ['単一DB', '記録の数値が変わり、複製へ自動で写る。付随する情報は複製だけ', '数値・複製'],
        ['DB＋ハッシュ', '数値に加えて、いまの値・保存した値（ハッシュ）も計算し直して保存される', '数値・ハッシュ・複製'],
        ['ブロックチェーン', '受け付けたノード（VM1）がブロックを追記し、ほかのノードへ伝わって3台の台帳がそろう。前のブロックは残り、前のハッシュでつながる', '数値・ブロック・状態DB', true],
      ],
      key: '正規の手続きでは、<b>数値と一緒に、付随する情報（複製・ハッシュ・ブロック）もそろって更新</b>される。だから照合しても食い違いは出ない。次のシナリオB では、手続きを踏まずに数値だけが書き換わったらどうなるかを見る。',
    },
    b: {
      rows: [
        ['単一DB', '書き換わった値が、そのまま複製へ写る。照合の手がかりがない', 'そのまま複製される'],
        ['DB＋ハッシュ', 'いまの値と保存した値が合わず、複製の前に止まる。トラブルが起きたことは分かる', '照合が合わず止まる', true],
        ['ブロックチェーン', 'VM1 の記録を、ほかのノードも持つ台帳と照合して食い違いに気付き、止める', '検知して止める', true],
      ],
      key: '手続きを踏まずに数値だけを書き換えると、<b>付随する情報（ハッシュ・台帳）と食い違う</b>。ブロックチェーンでは、台帳を<b>ほかのノードも持っている</b>ので、VM1 の記録が狂ったことが分かり、正しい値も確かめられる。',
    },
    c: {
      rows: [
        ['単一DB', '申請を受け付けるのは記録（マシン1）だけ。複製はバックアップを取るだけで代わりに受け付けない。止まると申請は消える', '受け付けられない'],
        ['DB＋ハッシュ', '単一DBと同じく、記録（マシン1）に頼っている', '受け付けられない'],
        ['ブロックチェーン', '動いている VM2・VM3 が受け付けて共有する。戻った VM1 は、ほかのノードから追いつく', '続けられる', true],
      ],
      key: 'DB の方式は <b>VM1 が止まっている限り受付できない</b>。ブロックチェーンは、同じ台帳を<b>複数のノード</b>が持つので、<b>どれかのノードが動いていれば受け付けられる</b>（可用性）。',
    },
    d: {
      rows: [
        ['単一DB', '記録（マシン1）が止まっているので受け付けられない', '受け付けられない'],
        ['DB＋ハッシュ', '単一DBと同じ', '受け付けられない'],
        ['ブロックチェーン', '動いているのは1台だけ。台帳は読めるが、書き込むには3台中2台（過半数）の合意が必要', '読み込みのみ', true],
        ['2台が戻ったあと', '3方式とも、出し直した申請を書き込める', '再開'],
      ],
      key: 'ブロックチェーンでも、<b>過半数（3台中2台）</b>が止まると合意できず、書き込めない（読み込みのみ）。これが限界。',
    },
  };
  function summaryHtml() {
    const { rows, key } = SUMMARY[SCN];
    const next = NEXT[SCN];
    return `<div class="scn-summary">
      <h3>まとめ</h3>
      ${rows.map(([name, why, res, strong]) => `<div class="scn-sum-row">
        <div class="scn-sum-head"><b>${name}</b><span class="scn-sum-res ${strong ? 'is-found' : ''}">${res}</span></div>
        <div class="scn-sum-why">${why}</div>
      </div>`).join('')}
      <div class="scn-sum-key">${key}</div>
      ${next ? `<a class="scn-btn scn-go-next" href="#scenario-${next}">次へ：${NAMES[next]}</a>` : ''}
      <button type="button" class="scn-btn is-ghost" data-download>結果をダウンロード</button>
      <button type="button" class="scn-btn is-ghost" data-restart>最初からやり直す</button>
    </div>`;
  }

  function renderPanel() {
    const p = $('scnPanel');
    if (!p) return;
    let h = '';
    if (S.step === 0) {
      h = `<h2>はじめに</h2>
        <p>まず、このシナリオの状況と画面の見方を説明します。</p>
        <button type="button" class="scn-btn" data-intro ${S.ready ? '' : 'disabled'}>解説を開く</button>`;
    } else if (SCN === 'a') h = updatePanel();
    else if (SCN === 'b') h = tamperPanel();
    else h = failPanel();
    const isSummary = h.includes('scn-summary');
    renderSteps(isSummary ? 2 : S.step);
    p.innerHTML = h;
    if (S.auditing) {
      const res = p.querySelector('.scn-res');
      if (res) res.scrollIntoView({ block: 'nearest' });
    }
    const sum = p.querySelector('.scn-summary');
    if (sum && !S.summaryShown) { S.summaryShown = true; log('summary'); sum.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
  }

  // ---------- 解説（マップの上に重ねる） ----------
  function legendHtml() {
    return `<div class="scn-legend"><span class="scn-legend-swatch"></span>青く光った所が、いま見る所（変わった所）です。<span class="scn-legend-swatch is-danger"></span>赤は、正規の手続きを通らない変化です。</div>`;
  }
  const viewList = () => `<ul class="scn-list">
      <li><b>上：ブロックチェーン</b> … VM1〜VM3 の3台のノード。それぞれにブロック（台帳）と状態DB が並ぶ。右に VM1 の記録。</li>
      <li><b>下の左：単一DB</b> … マシン1（記録）とマシン2・3（複製）。</li>
      <li><b>下の右：DB＋ハッシュ</b> … 各マシンに、備品データ（帳票A）と保存したハッシュ（帳票B）。</li>
    </ul>`;
  const INTRO_A = [
    () => `<h2>状況</h2>
      <p class="scn-lead">研究室の${ITEM.name}は <b>${ITEM.quantity}台</b> と記録されています。</p>
      <div class="scn-story">
        <b>出来事</b><span>昨日1台が壊れて廃棄されました。</span>
        <b>正規の更新</b><span>決められた手続き（更新の申請）で、記録を <b>${BASE_QTY}台</b> に直します。</span>
      </div>
      <p>このとき、3つの方式それぞれで、<b>数値</b>と、それに付随する<b>情報</b>（複製・ハッシュ・ブロック）がどう更新されるかを見ていきます。これが、あとのシナリオの基準になる「正しい更新」です。</p>`,
    () => `<h2>3つの方式のしくみ</h2>
      <div class="scn-cards">
        <div class="scn-card"><h3>単一DB</h3><div class="scn-mini"><span>記録</span><span>複製</span><span>複製</span></div><p>記録を1つのデータベースに持ち、<b>複製</b>へ自動で写す。</p></div>
        <div class="scn-card"><h3>DB＋ハッシュ</h3><div class="scn-mini"><span>記録</span><span>ハッシュ</span><span>複製</span></div><p>記録に加えて、記録の値から計算した<b>ハッシュ</b>（指紋のような値）を保存しておく。</p></div>
        <div class="scn-card"><h3>ブロックチェーン</h3><div class="scn-mini"><span>VM1 台帳</span><span>VM2 台帳</span><span>VM3 台帳</span></div><p>更新の申請を<b>ブロック</b>として、3台のノードが同じ台帳に追記していく。</p></div>
      </div>`,
    () => `<h2>画面の見方</h2>
      <p class="scn-lead">左のマップには、同じ${ITEM.name}の記録が3つの方式で並んでいます。</p>
      ${viewList()}
      ${legendHtml()}
      <p>変化があるたびに、変わった所が光って吹き出しが出ます。確かめたら「確認した」を押して進みます。</p>`,
  ];
  const INTRO_B = [
    () => `<h2>状況</h2>
      <p class="scn-lead">シナリオA で、${ITEM.name}は正規の手続きにより <b>${BASE_QTY}台</b> に更新されました。ハッシュも台帳も、${BASE_QTY}台にそろっています。</p>
      <div class="scn-story">
        <b>感染</b><span>VM1 が<b>マルウェア</b>に感染しました。</span>
        <b>書換え</b><span>マルウェアは<b>正規の手続きを踏まずに</b>、データの中から「${BASE_QTY}」を探し出し、<b>${TAMPERED_QTY}</b> に直接書き換えます。</span>
        <b>付随する情報</b><span>申請を通らないので、ハッシュやブロックは更新されません。</span>
      </div>
      <p>3つの方式それぞれで、この書き換えが<b>そのまま広がるのか、止められるのか</b>を確かめます。</p>`,
    () => `<h2>照合のしくみ</h2>
      <p class="scn-lead">記録を、別に残しておいた<b>照合の手がかり</b>と見比べます。食い違いがあれば「書き換えられた」と分かります。</p>
      <div class="scn-fig">
        <div class="scn-fig-box">記録<br><b>${TAMPERED_QTY}台</b></div>
        <div class="scn-fig-arrow">⇄<br><small>見比べる</small></div>
        <div class="scn-fig-box is-ref">照合の手がかり<br><b>?</b></div>
        <div class="scn-fig-arrow">→</div>
        <div class="scn-fig-res"><span class="ok">一致：問題なし</span><span class="ng">食い違い：書き換えに気付く</span></div>
      </div>
      <div class="scn-cards">
        <div class="scn-card"><h3>単一DB</h3><p>手がかりは<b>複製</b>。記録をそのまま写したもの。</p></div>
        <div class="scn-card"><h3>DB＋ハッシュ</h3><p>手がかりは<b>保存した値</b>。正規の更新のときに計算したハッシュ。</p></div>
        <div class="scn-card"><h3>ブロックチェーン</h3><p>手がかりは<b>台帳</b>。VM1 だけでなく、VM2・VM3 のノードも持つ。</p></div>
      </div>`,
    () => `<h2>画面の見方</h2>
      ${viewList()}
      ${legendHtml()}
      <p>右のパネルの指示に従って、マルウェア → 単一DB → DB＋ハッシュ → ブロックチェーンの順に確かめます。</p>`,
  ];
  const INTRO_FAIL = [
    () => `<h2>状況</h2>
      <p class="scn-lead">3つの方式は、どれも <b>3台のサーバー（VM1〜VM3）</b> で動いています。</p>
      <div class="scn-story">
        <b>故障</b><span><b>${vmName(STOP_LIST)}</b> が故障で止まります（${SCN === 'c' ? '3台中1台' : '3台中2台'}）。</span>
        <b>申請</b><span>止まっている間に${ITEM.name}が1台壊れたので、更新の申請（${ITEM.quantity}台 → ${BASE_QTY}台）を出します。</span>
        <b>復帰</b><span>修理が終わったら、止まったサーバーを動かします。</span>
      </div>
      <p>3つの方式それぞれで、<b>止まっている間に申請を受け付けられるか</b>を確かめます。${SCN === 'd' ? 'シナリオC との違いは、止まる台数だけです。' : ''}</p>`,
    () => `<h2>受付のしくみ</h2>
      <div class="scn-cards">
        <div class="scn-card"><h3>単一DB</h3><div class="scn-mini"><span>記録</span><span>複製</span><span>複製</span></div><p>申請を受け付けるのは<b>記録（VM1 のマシン1）だけ</b>。複製はデータのバックアップを取るだけで、代わりには受け付けない。</p></div>
        <div class="scn-card"><h3>DB＋ハッシュ</h3><div class="scn-mini"><span>記録＋ハッシュ</span><span>複製</span></div><p>単一DBと同じく、<b>記録（マシン1）</b>が受け付ける。</p></div>
        <div class="scn-card"><h3>ブロックチェーン</h3><div class="scn-mini"><span>VM1 台帳</span><span>VM2 台帳</span><span>VM3 台帳</span></div><p>どのノードでも申請を受け付け、ほかのノードと共有する。ブロックの追加には<b>3台中2台以上（過半数）の合意</b>が要る。</p></div>
      </div>`,
    () => `<h2>画面の見方</h2>
      <ul class="scn-list">
        <li><b>上：ブロックチェーン</b> … VM1〜VM3 のノード。それぞれにブロック（台帳）と状態DB が並ぶ。</li>
        <li><b>下の左：単一DB</b>、<b>下の右：DB＋ハッシュ</b> … マシン1（記録）が VM1、マシン2・3（複製）が VM2・VM3 に載っている。</li>
        <li><b>止まったサーバー</b> … 灰色になる。</li>
      </ul>
      ${legendHtml()}
      <p>右のパネルの指示に従って、止める → 申請する → 動かす の順に試します。</p>`,
  ];
  const INTRO_PAGES = { a: INTRO_A, b: INTRO_B, c: INTRO_FAIL, d: INTRO_FAIL }[SCN];

  /** 故障シナリオの始めに、VM ごとに何が載っているかを見せる */
  function tourFail() {
    const k = '見方';
    return spot([
      { tone: 'info', kicker: k, targets: [vmCards(0), '#peerLane0'], focus: FOCUS.all, max: 1, title: 'VM1 に載っているもの', text: '単一DB・DB＋ハッシュの<b>記録（マシン1）</b>と、ブロックチェーンの <b>VM1 のノード</b>です。' },
      { tone: 'info', kicker: k, targets: [vmCards(1), vmCards(2), '#peerLane1', '#peerLane2'], focus: FOCUS.all, max: 1, title: 'VM2・VM3 に載っているもの', text: '単一DB・DB＋ハッシュでは、記録を写す<b>複製</b>。ブロックチェーンでは、VM1 と<b>同じ台帳を持つノード</b>です。' },
    ]);
  }
  /** シナリオB の始めに、正規の更新が済んだ状態を見せる */
  function tourTamper() {
    const k = 'いまの状態';
    return spot([
      { tone: 'ok', kicker: k, targets: [Q.c01Master, Q.c02Qty, '.scn-record'], focus: FOCUS.all, max: 1, title: `記録はどれも ${BASE_QTY}台`, text: `シナリオA の正規の更新で、3つの方式の記録は <b>${BASE_QTY}台</b> になっています。` },
      { tone: 'ok', kicker: k, targets: [Q.c02Current, Q.c02Stored], focus: [C02], title: 'ハッシュもそろっている', text: '「いまの値」と「保存した値」は同じです。' },
      { tone: 'ok', kicker: k, targets: [allQtyRows], focus: [allBlocks], pad: 60, title: `台帳にも ${BASE_QTY}台 の履歴`, text: `3台の台帳の最新のブロックに、正規の更新（<b>${BASE_QTY}台</b>）が残っています。` },
    ]);
  }
  function openIntro() {
    closeModal();
    const i = S.introPage;
    const last = i === INTRO_PAGES.length - 1;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="scn-modal-back" id="scnModal"><div class="scn-modal scn-intro" role="dialog" aria-label="解説">
        <div class="scn-intro-count">解説 ${i + 1} / ${INTRO_PAGES.length}</div>
        ${INTRO_PAGES[i]()}
        <div class="scn-modal-actions">
          ${i > 0 ? '<button type="button" class="scn-btn is-ghost" data-intro-prev>戻る</button>' : ''}
          <button type="button" class="scn-btn" data-intro-next>${last ? '体験を始める' : '次へ'}</button>
        </div>
      </div></div>`);
  }
  function closeModal() { const m = $('scnModal'); if (m) m.remove(); }

  function startExperience() {
    closeModal();
    log('intro-done');
    S.step = 1;
    renderPanel();
    if (IS_FAIL) void tourFail();
    else if (SCN === 'b') void tourTamper();
    else overview();
  }

  function download() {
    const rec = {
      scenario: NAMES[SCN],
      startedAt: S.startedAt,
      finishedAt: new Date().toISOString(),
      legitUpdate: S.legit,
      trials: S.trials,
      writes: S.tries,
      events: S.events,
    };
    const blob = new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' });
    const el = document.createElement('a');
    el.href = URL.createObjectURL(blob);
    el.download = `scenario${SCN.toUpperCase()}_record_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    el.click();
  }

  // ---------- イベント ----------
  const ACTS = {
    malware: runMalware,
    replicate: replicateSingle,
    'check-single': () => tamperCheck('single'),
    'check-hash': () => tamperCheck('hash'),
    'check-fabric': () => tamperCheck('fabric'),
    stop: stopVms,
    write: attemptWrite,
    restart: restartVms,
  };
  function bind() {
    document.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t || !t.closest('#scnPanel, #scnModal')) return;
      if (S.guiding || S.auditing) return; // 吹き出しで確認している間は、パネルの操作を受け付けない
      const d = t.dataset;
      if (t.hasAttribute('data-intro')) { S.introPage = 0; openIntro(); }
      else if (t.hasAttribute('data-intro-prev')) { S.introPage -= 1; openIntro(); }
      else if (t.hasAttribute('data-intro-next')) {
        if (S.introPage < INTRO_PAGES.length - 1) { S.introPage += 1; openIntro(); } else startExperience();
      } else if (d.act && ACTS[d.act]) void ACTS[d.act]();
      else if (t.hasAttribute('data-apply')) {
        const qty = Number($('scnFormQty').value);
        const reason = $('scnFormReason').value;
        const msg = $('scnFormMsg');
        if (!reason) { msg.textContent = '理由を選んでください。'; return; }
        if (qty !== BASE_QTY || reason !== '廃棄') { msg.textContent = `今回は「個数 ${BASE_QTY}・理由 廃棄」で申請してください。`; return; }
        void legitUpdate(qty, reason);
      } else if (t.hasAttribute('data-download')) download();
      else if (t.hasAttribute('data-restart')) { window.__goDemo(SCN); }
    }, true);
  }

  async function start() {
    mountShell();
    bind();
    renderPanel();
    await waitForBoot();
    setupWorld();
    S.ready = true;
    log('start');
    renderPanel();
    setTimeout(() => { if (S.step === 0 && !$('scnModal')) openIntro(); }, 600);
  }

  window.DemoScenario = { state: S };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void start(); });
  else void start();
})();
