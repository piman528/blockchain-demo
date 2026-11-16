// ==========================================================================
// demo-mockup-core.js
//   - 全シナリオ共通: state, ユーティリティ, シナリオ管理,
//     ズーム/パン, 粒子, render エントリ, 共通レンダリング(マスタ),
//     マスタ起点のドメイン操作(registerItem/regularUpdate/tamperMaster), reset
//   - 後続スクリプト(demo-mockup-c03.js, demo-mockup-c01c02.js, demo-mockup-bind.js)
//     から参照される変数・関数はトップレベルで宣言する
// ==========================================================================

let txCounter = 0;
let logCounter = 0;
let peers = [
  { id: 0, name: 'VM1', blocks: [], worldState: {}, tampered: false, couchTampered: false, verifyDetected: false },
  { id: 1, name: 'VM2', blocks: [], worldState: {}, tampered: false, couchTampered: false, verifyDetected: false },
  { id: 2, name: 'VM3', blocks: [], worldState: {}, tampered: false, couchTampered: false, verifyDetected: false },
];
let masterItems = {};
let verifyDetails = [];
let localHashStore = {};
// C-02 帳票B: スレーブ側の item_hashes（マスタ localHashStore と同数レーン）
let slaveLocalHashStores = [{}, {}];
// C-01 / C-02 のスレーブDB（マスタ→スレーブのタンデムレプリケーション想定）
// 各要素は { [itemId]: { ...snapshot } } の形でマスタの値を保持。
let slaveDbItems = [{}, {}];
// 3方式比較で、単一DB（C-01）の複製だけ別の値を見せたいとき（シナリオ）に使う。null なら slaveDbItems を共有する
let c01SlaveDbItems = null;
let comparisonVerified = false;
let autoVerifyTimer = null;

/** 操作後に整合性検証を自動実行（連打・連続操作はまとめて1回） */
/** 「3方式比較」タブ：C-03 のマップ上に C-01 / C-02 も並べて、同じ操作を同時にかける表示 */
function isAllMethodsView() {
  return typeof document !== 'undefined' && document.body && document.body.dataset.compareView === 'on';
}
function scheduleAutoVerify(delayMs = 400) {
  if (autoVerifyTimer) clearTimeout(autoVerifyTimer);
  autoVerifyTimer = setTimeout(() => {
    autoVerifyTimer = null;
    if (typeof verifyAll !== 'function') return;
    void verifyAll();
  }, delayMs);
}
let c02TamperMode = 'A';
// C-03 中間ブロック改ざん演出用の一時状態（実データには影響しない）
let demoOverlayState = { peerId: null, blockNum: null, fakeHash: null };
// C-03 障害シナリオ（Mock）用の状態。実機のノードには一切触れない。
let mockFailureMode = false;
let mockNodeStates = [true, true, true];
let changeSpotlightTimer = null;
let clearNewStateTimer = null;
let activeScenario = 'c03';

function isMockNodeAvailable(index) {
  return !mockFailureMode || mockNodeStates[index] !== false;
}

function mockAvailableNodeCount() {
  return mockNodeStates.filter(Boolean).length;
}

function canWriteMockLedger() {
  // 3台中2台以上が停止すると、合意が取れず書き込みは失敗する。
  return !mockFailureMode || mockAvailableNodeCount() >= 2;
}

function canReadMockLedger() {
  return !mockFailureMode || mockAvailableNodeCount() >= 1;
}

/** 画面中央上部の「何が変わったか」表示を消す。 */
function hideChangeSpotlight() {
  const el = document.getElementById('changeSpotlight');
  if (el) el.hidden = true;
  if (changeSpotlightTimer) {
    clearTimeout(changeSpotlightTimer);
    changeSpotlightTimer = null;
  }
}

/** 画面中央上部に「何が変わったか」を数秒だけ表示する。 */
function announceChange(text, tone = 'info', durationMs = 3600) {
  const el = document.getElementById('changeSpotlight');
  const textEl = document.getElementById('changeSpotlightText');
  if (!el || !textEl) return;
  textEl.textContent = text;
  el.className = `map-change-spotlight is-${tone}`;
  el.hidden = false;
  if (changeSpotlightTimer) clearTimeout(changeSpotlightTimer);
  changeSpotlightTimer = setTimeout(() => {
    el.hidden = true;
    changeSpotlightTimer = null;
  }, durationMs);
}

/**
 * Mock の障害シナリオ。ノードを停止し、復帰時に稼働ノードから差分を同期する。
 * 実機の Docker / Proxmox は操作しない。
 */
function setMockNodeState(index, up) {
  if (!mockFailureMode) return { changed: false };
  const i = Number(index);
  const peer = peers[i];
  if (!peer || mockNodeStates[i] === Boolean(up)) return { changed: false };

  mockNodeStates[i] = Boolean(up);
  let syncedBlocks = 0;

  if (!up) {
    peer.wasDown = true;
    peer.blocks.forEach((block) => { block.isNew = false; });
    Object.values(peer.worldState).forEach((entry) => { entry.updated = false; });
    announceChange(
      `${peer.name} を停止 — このノードには新しい記録が届きません`,
      'danger',
      4600,
    );
    pushLog(`${peer.name} を停止（シミュレーション）`, 'warn');
  } else {
    // 稼働中で最も進んでいるノードを同期元にする。
    const source = peers
      .map((p, idx) => ({ peer: p, idx }))
      .filter(({ idx }) => idx !== i && mockNodeStates[idx])
      .sort((a, b) => b.peer.blocks.length - a.peer.blocks.length)[0];

    if (source) {
      const before = peer.blocks.length;
      peer.blocks = source.peer.blocks.map((block, idx) => ({
        ...block,
        txs: block.txs.map((tx) => ({ txId: tx.txId, record: { ...tx.record } })),
        isNew: idx >= before,
        verifyMismatch: false,
        minority: false,
      }));
      peer.worldState = {};
      Object.entries(source.peer.worldState).forEach(([key, entry]) => {
        peer.worldState[key] = {
          kind: entry.kind,
          value: { ...entry.value },
          updated: false,
          verifyMismatch: false,
        };
      });
      syncedBlocks = Math.max(0, peer.blocks.length - before);
    }

    peer.wasDown = false;
    peer.tampered = false;
    peer.couchTampered = false;
    peer.verifyDetected = false;
    announceChange(
      syncedBlocks > 0
        ? `${peer.name} が復帰 — 停止中に追加された ${syncedBlocks} ブロックを同期しました`
        : `${peer.name} が復帰 — 未同期のブロックはありません`,
      'ok',
      4800,
    );
    pushLog(
      `${peer.name} を復帰（シミュレーション）`
        + (syncedBlocks > 0 ? ` / ${syncedBlocks} ブロックを同期` : ' / 差分なし'),
      'ok',
    );
  }

  render();
  if (typeof updateConnectionStatusBanner === 'function') updateConnectionStatusBanner();
  // 停止/復帰でボタンの文言が変わるため、パネルごと作り直す。
  if (mockFailureMode && typeof loadNodeOpsPanel === 'function') {
    void loadNodeOpsPanel();
  } else if (typeof refreshNodeOpsStatus === 'function') {
    void refreshNodeOpsStatus();
  }
  return { changed: true, syncedBlocks };
}
const DEMO_STORY_STEPS = {
  c01: [
    { id: 0, label: '準備', hint: '備品を登録してください' },
    { id: 1, label: '改ざん', hint: '「マスタだけ改ざん」で個数を書き換え' },
    { id: 2, label: '照合', hint: '自動照合の結果を画面上で確認' },
  ],
  c02: [
    { id: 0, label: '準備', hint: '備品を登録し、正規更新で個数と保存した値が連動する様子を確認' },
    { id: 1, label: '改ざん', hint: '「マスタだけ改ざん」→ 個数が赤枠で変わる' },
    { id: 2, label: '照合', hint: '自動照合の結果を画面上で確認' },
    { id: 3, label: 'モードB', hint: 'モードBに切替 → 再改ざんで保存した値も同時更新' },
    { id: 4, label: '限界', hint: '自動照合でもローカルだけでは検知不可になることを確認' },
  ],
  c03: [
    { id: 0, label: '準備', hint: '備品を登録してください' },
    { id: 1, label: '改ざん', hint: '「マスタだけ改ざん」でマスタだけを書き換え' },
    { id: 2, label: '照合', hint: '自動照合でマスタと台帳の不一致を確認' },
  ],
};
const SCENARIO_META = {
  c01: { title: '単一DB（マスタ + スレーブ2台）' },
  c02: { title: 'DB + ローカルハッシュ（マスタ + スレーブ2台）' },
  c03: { title: 'ブロックチェーンの台帳マップ' },
};
const SCENARIOS = new Set(['c01', 'c02', 'c03']);

// ===== マスタ→スレーブ レプリケーション =====
function snapshotForReplication(item) {
  if (!item) return null;
  // マスタの値だけコピー（_tampered / _updated などの内部フラグも含む）
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    quantity: item.quantity,
    location: item.location,
    status: item.status,
    version: item.version || 0,
    _tampered: !!item._tampered,
    _tamperedFromQty: typeof item._tamperedFromQty === 'number' ? item._tamperedFromQty : undefined,
    _updated: !!item._updated,
  };
}
function replicateToSlaves(itemId) {
  const item = masterItems[itemId];
  if (!item) return;
  slaveDbItems.forEach((slave) => {
    slave[itemId] = snapshotForReplication(item);
  });
}
function getHashStoreForLane(role, slaveIndex) {
  if (role === 'slave' && typeof slaveIndex === 'number') {
    return slaveLocalHashStores[slaveIndex] || {};
  }
  return localHashStore;
}
function replicateHashToSlaves(itemId, options = {}) {
  const masterEntry = localHashStore[itemId];
  if (!masterEntry) return;
  slaveLocalHashStores.forEach((store) => {
    store[itemId] = { ...masterEntry };
    if (options.tampered) store[itemId]._tampered = true;
  });
}
function replicateAllToSlaves() {
  slaveDbItems.forEach((slave) => {
    Object.keys(slave).forEach((k) => { delete slave[k]; });
  });
  slaveLocalHashStores.forEach((store) => {
    Object.keys(store).forEach((k) => { delete store[k]; });
  });
  Object.keys(masterItems).forEach((id) => {
    slaveDbItems.forEach((slave) => {
      slave[id] = snapshotForReplication(masterItems[id]);
    });
    replicateHashToSlaves(id);
  });
}

// ===== マップビュー（ズーム/パン） =====
const view = { x: 12, y: 12, scale: 0.7 };
const mapStage = document.getElementById('mapStage');
const mapWorld = document.getElementById('mapWorld');

function applyView() {
  mapWorld.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  const zoomLabel = document.getElementById('canvasZoom');
  if (zoomLabel) zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
}

function updateC02ModeSelector() {
  const selector = document.getElementById('c02ModeSelector');
  if (!selector) return;
  selector.hidden = activeScenario !== 'c02' && !isAllMethodsView();
  selector.querySelectorAll('input[name="c02TamperMode"]').forEach((input) => {
    input.checked = input.value === c02TamperMode;
  });
}

function updateMidBlockTamperPanel() {
  const panel = document.getElementById('midBlockTamperPanel');
  if (!panel) return;
  panel.hidden = activeScenario !== 'c03';
  // C-03 のとき対象ブロックセレクトを再構築（中間=先頭・末尾以外）
  const peerSel = document.getElementById('midBlockPeer');
  const numSel = document.getElementById('midBlockNum');
  if (!peerSel || !numSel) return;
  const peerId = Number(peerSel.value) || 0;
  const peer = peers[peerId];
  const blocks = peer ? peer.blocks : [];
  // 中間ブロック: 番号 1 以上 かつ 最終ブロックではない（=連鎖の前後を持つ）
  const midNums = [];
  for (let i = 1; i < blocks.length - 1; i++) midNums.push(blocks[i].num);
  const prev = numSel.value;
  numSel.innerHTML = midNums.length
    ? midNums.map((n) => `<option value="${n}">Block #${n}</option>`).join('')
    : '<option value="">（中間ブロックなし）</option>';
  if (prev && midNums.includes(Number(prev))) numSel.value = prev;
  const btn = document.getElementById('btnTamperMidBlock');
  if (btn) btn.disabled = !midNums.length;
}

function setActiveScenario(scenario) {
  activeScenario = SCENARIOS.has(scenario) ? scenario : 'c03';
  hideChangeSpotlight();
  mapWorld.dataset.scenario = activeScenario;
  const titleEl = document.getElementById('scenarioTitle');
  if (titleEl) titleEl.textContent = SCENARIO_META[activeScenario].title;
  document.querySelectorAll('[data-scenario-tab]').forEach((button) => {
    const selected = button.getAttribute('data-scenario-tab') === activeScenario;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  updateC02ModeSelector();
  // シナリオ切替時はオーバーレイ演出も解除
  if (activeScenario !== 'c03') {
    demoOverlayState = { peerId: null, blockNum: null, fakeHash: null };
    // C-01/C-02 は Fabric のノード障害とは別の模型なので、ノード状態を戻してから切り替える。
    if (mockFailureMode) {
      mockNodeStates = [true, true, true];
      peers.forEach((p) => { p.wasDown = false; });
    }
  }
  updateMidBlockTamperPanel();
  updateMasterFloatTitle();
  updateMethodExplainer();
  updateScenarioLayout();
  render();
  if (typeof updateConnectionStatusBanner === 'function') updateConnectionStatusBanner();
  if (mockFailureMode && typeof loadNodeOpsPanel === 'function') {
    void loadNodeOpsPanel();
  }
  scheduleAutoVerify(250);
}

function updateScenarioLayout() {
  document.body.dataset.scenario = activeScenario;
  const comparisonStage = document.getElementById('comparisonStage');
  if (comparisonStage) comparisonStage.hidden = activeScenario === 'c03';
  if (activeScenario !== 'c03') {
    view.x = 12;
    view.y = 12;
    view.scale = 0.7;
    applyView();
  }
  updateLayoutMetrics();
}

function updateMethodExplainer() {
  const container = document.getElementById('explainerSvgContainer');
  const title = document.getElementById('methodExplainerTitle');
  if (!container || !title) return;

  // シナリオに対応するSVGファイルマップ
  const SVG_MAP = {
    'c01': { file: 'F-4_single-db.svg', title: '単一DB方式の仕組み' },
    'c02': { file: 'F-5_db-hash.svg', title: 'DB＋ハッシュ方式の仕組み' },
    'c03': { file: 'F-6_fabric.svg', title: 'ブロックチェーン方式の仕組み' }
  };

  const config = SVG_MAP[activeScenario];
  if (!config) return;

  title.textContent = config.title;
  
  // 既存のSVGを削除
  container.innerHTML = '';
  
  // 新しいSVGを読み込み
  fetch(`assets/${config.file}`)
    .then(response => response.text())
    .then(svgText => {
      container.innerHTML = svgText;
    })
    .catch(error => {
      console.warn('SVG読み込みエラー:', error);
      container.innerHTML = '<div style="padding: 40px; text-align: center; color: #64748b;">図を読み込み中...</div>';
    });
}

function showTamperingAlert(type = 'master') {
  const alertEl = document.getElementById('tamperingAlert');
  const svgContainer = document.getElementById('alertSvgContainer');
  const message = document.getElementById('alertMessage');
  
  if (!alertEl || !svgContainer || !message) return;

  // 改ざん種別に応じたSVGとメッセージ
  const TAMPERING_CONFIG = {
    'master': { file: 'F-1_tampering-person.svg', message: 'マスタデータが改ざんされました！' },
    'peer': { file: 'F-1_tampering-person.svg', message: 'ピアノードで改ざんが発生しました！' },
    'silent': { file: 'F-9_silent-rewrite.svg', message: '静かな書き換えが実行されました！' }
  };

  const config = TAMPERING_CONFIG[type] || TAMPERING_CONFIG['master'];
  message.textContent = config.message;

  // SVGを読み込み
  fetch(`assets/${config.file}`)
    .then(response => response.text())
    .then(svgText => {
      svgContainer.innerHTML = svgText;
      alertEl.hidden = false;
      
      // 3秒後に自動的に非表示
      setTimeout(() => {
        alertEl.hidden = true;
      }, 3000);
    })
    .catch(error => {
      console.warn('改ざんアラートSVG読み込みエラー:', error);
    });
}

function updateLayoutMetrics() {
  const header = document.querySelector('.mockup-header');
  const brDock = document.querySelector('.mockup-br-dock');
  const body = document.body;
  if (header) {
    const top = header.getBoundingClientRect().bottom + 8;
    body.style.setProperty('--mock-safe-top', `${Math.ceil(top)}px`);
  }
  if (brDock) {
    const brH = Math.ceil(brDock.getBoundingClientRect().height);
    body.style.setProperty('--mock-br-h', `${Math.max(brH, 120)}px`);
    const bottomOffset = 10;
    const gap = 12;
    const sharedH = parseFloat(getComputedStyle(body).getPropertyValue('--tutorial-shared-h')) || 0;
    const tutorialActive = body.classList.contains('tutorial-active');
    const bottomBase = tutorialActive && sharedH > 0
      ? Math.max(sharedH, brH)
      : brH;
    const bottom = Math.min(
      Math.max(bottomBase + bottomOffset + gap, 72),
      Math.floor(window.innerHeight * 0.36),
    );
    const prev = parseFloat(getComputedStyle(body).getPropertyValue('--mock-safe-bottom')) || 0;
    if (Math.abs(prev - bottom) > 1) {
      body.style.setProperty('--mock-safe-bottom', `${Math.ceil(bottom)}px`);
    }
  }
}

function bindLayoutObservers() {
  if (typeof ResizeObserver === 'undefined') return;
  if (bindLayoutObservers._bound) return;
  bindLayoutObservers._bound = true;
  const header = document.querySelector('.mockup-header');
  const brDock = document.querySelector('.mockup-br-dock');
  const observer = new ResizeObserver(() => {
    window.requestAnimationFrame(() => updateLayoutMetrics());
  });
  if (header) observer.observe(header);
  if (brDock) observer.observe(brDock);
}

function updateMasterFloatTitle() {
  const title = document.getElementById('masterFloatTitle');
  if (!title) return;
  title.textContent = activeScenario === 'c03'
    ? '備品マスタ · VM1'
    : '備品マスタ';
}

function computeDemoStoryStep() {
  const itemId = document.getElementById('opTarget')?.value;
  const item = itemId && masterItems[itemId] ? masterItems[itemId] : null;
  const hasItems = Object.keys(masterItems).length > 0;
  if (!hasItems) return 0;

  if (activeScenario === 'c01') {
    if (!item || !item._tampered) return 1;
    return comparisonVerified ? 2 : 1;
  }

  if (activeScenario === 'c02') {
    if (!item || !item._tampered) return 1;
    const local = localHashStore[item.id];
    const currentHash = hashItem(item);
    const localMatches = local && local.hash === currentHash;
    if (comparisonVerified && localMatches) return 4;
    if (comparisonVerified && !localMatches) return 3;
    if (!comparisonVerified && localMatches) return 4;
    return 2;
  }

  // c03
  if (!item || !item._tampered) return 1;
  return comparisonVerified ? 2 : 1;
}

function renderDemoStoryGuide() {
  const el = document.getElementById('demoStoryGuide');
  if (!el) return;
  const steps = DEMO_STORY_STEPS[activeScenario] || DEMO_STORY_STEPS.c03;
  const current = computeDemoStoryStep();
  const currentMeta = steps[current] || steps[steps.length - 1];
  el.innerHTML = `
        <div class="demo-story-steps" aria-label="デモの流れ">
          ${steps.map((step) => `
            <span class="demo-story-step ${step.id === current ? 'is-active' : ''} ${step.id < current ? 'is-done' : ''}">
              <span class="demo-story-num">${step.id + 1}</span>${step.label}
            </span>
          `).join('<span class="demo-story-arrow">→</span>')}
        </div>
        <p class="demo-story-hint">${currentMeta.hint}</p>
      `;
  updateLayoutMetrics();
}

function zoomAt(factor, cx, cy) {
  const stageRect = mapStage.getBoundingClientRect();
  cx -= stageRect.left;
  cy -= stageRect.top;
  const newScale = Math.max(0.2, Math.min(2.5, view.scale * factor));
  const k = newScale / view.scale;
  // (cx, cy) 中心でズーム
  view.x = cx - (cx - view.x) * k;
  view.y = cy - (cy - view.y) * k;
  view.scale = newScale;
  applyView();
}

function zoomMapFromToolbar(factor) {
  const rect = mapStage.getBoundingClientRect();
  zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function fitMapToViewport() {
  if (activeScenario !== 'c03' || !mapStage.clientWidth) return;
  const worldRect = mapWorld.getBoundingClientRect();
  const nodes = mapWorld.querySelectorAll(isAllMethodsView()
    ? '.peer-label, .peer-rail > .block, .peer-rail > .couchdb, .method-region'
    : '.peer-label, .peer-rail > .block, .peer-rail > .couchdb');
  let right = 0;
  let bottom = 0;
  nodes.forEach((node) => {
    const rect = node.getBoundingClientRect();
    right = Math.max(right, (rect.right - worldRect.left) / view.scale);
    bottom = Math.max(bottom, (rect.bottom - worldRect.top) / view.scale);
  });
  if (!right || !bottom) return;
  view.scale = Math.max(0.2, Math.min(1, (mapStage.clientWidth - 32) / right, (mapStage.clientHeight - 32) / bottom));
  view.x = Math.max(16, (mapStage.clientWidth - right * view.scale) / 2);
  view.y = Math.max(16, (mapStage.clientHeight - bottom * view.scale) / 2);
  applyView();
  renderSvgArrows();
}

// パン
let panning = false;
let panStart = { x: 0, y: 0, vx: 0, vy: 0 };
mapStage.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  panning = true;
  panStart = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  mapStage.classList.add('is-panning');
});
window.addEventListener('mousemove', (e) => {
  if (!panning) return;
  view.x = panStart.vx + (e.clientX - panStart.x);
  view.y = panStart.vy + (e.clientY - panStart.y);
  applyView();
});
window.addEventListener('mouseup', () => {
  panning = false;
  mapStage.classList.remove('is-panning');
});

// ホイールズーム
mapStage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  zoomAt(factor, e.clientX, e.clientY);
}, { passive: false });

// タッチ操作（簡易: ピンチ）
let lastTouchDist = 0;
mapStage.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    lastTouchDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
  } else if (e.touches.length === 1) {
    panning = true;
    panStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, vx: view.x, vy: view.y };
  }
});
mapStage.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (e.touches.length === 2) {
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    if (lastTouchDist) {
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      zoomAt(d / lastTouchDist, cx, cy);
    }
    lastTouchDist = d;
  } else if (e.touches.length === 1 && panning) {
    view.x = panStart.vx + (e.touches[0].clientX - panStart.x);
    view.y = panStart.vy + (e.touches[0].clientY - panStart.y);
    applyView();
  }
}, { passive: false });
mapStage.addEventListener('touchend', () => {
  panning = false;
  lastTouchDist = 0;
});

// ===== ハッシュ・ID ヘルパー =====
/** SHA-256（同期・UTF-8）。Mock でも本物の Fabric と同じ長さ（64文字）のハッシュにするため */
const SHA256_K = (() => {
  const primes = [];
  for (let n = 2; primes.length < 64; n += 1) if (primes.every((p) => n % p)) primes.push(n);
  const frac = (x) => Math.floor((x - Math.floor(x)) * 0x100000000) >>> 0;
  return { k: Uint32Array.from(primes, (p) => frac(Math.cbrt(p))), h: Uint32Array.from(primes.slice(0, 8), (p) => frac(Math.sqrt(p))) };
})();
function sha256Hex(str) {
  const bytes = new TextEncoder().encode(String(str));
  const len = bytes.length;
  const total = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(len / 0x20000000));
  dv.setUint32(total - 4, (len << 3) >>> 0);
  const H = Uint32Array.from(SHA256_K.h);
  const K = SHA256_K.k;
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i += 1) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return Array.from(H, (x) => x.toString(16).padStart(8, '0')).join('');
}

/** 画面で使うハッシュ。本物の Fabric・サーバと同じ SHA-256（64文字） */
function hash(s) {
  return sha256Hex(s);
}
function hashItem(item) {
  const payload = JSON.stringify({
    id: item.id,
    name: item.name || '',
    category: item.category || '',
    quantity: Number(item.quantity || 0),
    location: item.location || '',
    status: item.status || '',
  });
  return hash(payload);
}
function isItemLedgerEvent(eventType) {
  return eventType === 'ITEM_UPDATE' || eventType === 'ITEM_CREATE';
}
function findLatestLedgerAf(peer, itemId) {
  for (let i = peer.blocks.length - 1; i >= 0; i--) {
    for (const tx of peer.blocks[i].txs) {
      if (tx.record.targetId === itemId && isItemLedgerEvent(tx.record.eventType)) {
        try { return JSON.parse(tx.record.note).af || ''; } catch (_) { }
      }
    }
  }
  return '';
}
function findLatestLedgerSnapshot(peer, itemId) {
  for (let i = peer.blocks.length - 1; i >= 0; i--) {
    for (const tx of peer.blocks[i].txs) {
      if (tx.record.targetId === itemId && isItemLedgerEvent(tx.record.eventType)) {
        try { return JSON.parse(tx.record.note).snap || null; } catch (_) { }
      }
    }
  }
  return null;
}
function itemSnapshot(item) {
  return {
    id: item.id,
    name: item.name || '',
    category: item.category || '',
    quantity: Number(item.quantity || 0),
    location: item.location || '',
    status: item.status || '',
  };
}
const SNAPSHOT_FIELDS = [
  ['id', 'id'],
  ['name', 'name'],
  ['category', 'category'],
  ['quantity', 'quantity'],
  ['location', 'location'],
  ['status', 'status'],
];
function formatCompareValue(value) {
  if (value === null || value === undefined || value === '') return '（空）';
  return String(value);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
/**
 * ハッシュを先頭10文字＋「…」で表示し、マウスを乗せる（キーボードならフォーカスする）と全体を表示する。
 * 10文字以下（Mock の8桁など）はそのまま出す。
 */
const HASH_SHORT_LEN = 10;
function hashHtml(value) {
  const full = String(value ?? '');
  if (full.length <= HASH_SHORT_LEN) return escapeHtml(full);
  const esc = escapeHtml(full);
  return `<span class="hash-abbr" tabindex="0" data-full="${esc}" aria-label="${esc}">${escapeHtml(full.slice(0, HASH_SHORT_LEN))}…</span>`;
}

/* 省略したハッシュにマウスを乗せる（フォーカスする）と、全文を吹き出しで浮かせて表示する。
   元の表示は動かさない。拡大縮小・スクロールの中でも隠れないよう、画面に固定した1つの要素を使う。 */
(function setupHashPopover() {
  if (typeof document === 'undefined') return;
  let pop = null;
  let current = null;
  let timer = null;
  // マウスを乗せてから吹き出しを出すまでの待ち時間（通り過ぎただけでは出さない）
  const HOVER_DELAY_MS = 400;
  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.className = 'hash-popover';
    pop.setAttribute('role', 'tooltip');
    pop.hidden = true;
    document.body.appendChild(pop);
    return pop;
  }
  function show(el) {
    const full = el.getAttribute('data-full');
    if (!full) return;
    current = el;
    const p = ensurePop();
    p.textContent = full;
    p.hidden = false;
    const r = el.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    const margin = 8;
    let top = r.top - pr.height - margin;
    if (top < margin) top = r.bottom + margin;
    let left = r.left + r.width / 2 - pr.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - pr.width - margin));
    p.style.top = `${Math.round(top)}px`;
    p.style.left = `${Math.round(left)}px`;
  }
  function hide(el) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (el && current && el !== current) return;
    current = null;
    if (pop) pop.hidden = true;
  }
  function showLater(el) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; if (el.isConnected && el.matches(':hover')) show(el); }, HOVER_DELAY_MS);
  }
  const target = (e) => (e.target instanceof Element ? e.target.closest('.hash-abbr') : null);
  document.addEventListener('mouseover', (e) => { const el = target(e); if (el) showLater(el); });
  document.addEventListener('mouseout', (e) => {
    const el = target(e);
    if (el && !(e.relatedTarget instanceof Element && el.contains(e.relatedTarget))) hide(el);
  });
  document.addEventListener('focusin', (e) => { const el = target(e); if (el) show(el); });
  document.addEventListener('focusout', (e) => { const el = target(e); if (el) hide(el); });
  // 地図を動かしたり再描画したりしたら閉じる
  ['wheel', 'mousedown', 'scroll'].forEach((t) => document.addEventListener(t, () => hide(), true));
})();
function buildSnapshotDiffRows(expected, current) {
  return SNAPSHOT_FIELDS.map(([key, label]) => {
    const expectedValue = expected ? expected[key] : '';
    const currentValue = current ? current[key] : '';
    return {
      key,
      label,
      expectedValue,
      currentValue,
      differs: formatCompareValue(expectedValue) !== formatCompareValue(currentValue),
    };
  });
}
function syncLocalHashStore(item, options = {}) {
  if (!item) return;
  localHashStore[item.id] = {
    hash: hashItem(item),
    snap: itemSnapshot(item),
    updatedAt: new Date().toLocaleTimeString('ja-JP'),
  };
  if (options.tampered) localHashStore[item.id]._tampered = true;
  if ((activeScenario === 'c01' || activeScenario === 'c02' || isAllMethodsView()) && !options.skipSlaveReplicate) {
    replicateHashToSlaves(item.id, options);
  }
}
function newTxId() {
  txCounter++;
  // 本物の Fabric の取引IDと同じく 64 文字の16進
  return hash('tx' + txCounter + Math.random());
}
function newLogId() {
  logCounter++;
  return 'LOG-' + String(logCounter).padStart(4, '0');
}
/**
 * ブロックを中身から検算した値。
 * 実ブロック（Live）はサーバが Fabric と同じ方法で計算した値を使い、画面上で改ざんした取引があれば別の値になる。
 */
function recomputeBlockHash(b) {
  if (b && b.real) {
    const tampered = b.txs.some((t) => t.record && t.record._tampered);
    return tampered ? hash(`tampered|${b.hash}|${JSON.stringify(b.txs.map((t) => t.record))}`) : (b.recomputedHash || b.hash);
  }
  return blockHashOf(b.prevHash, b.txs);
}
function blockHashOf(prevHash, txs) {
  const payload = prevHash + '|' + txs.map((t) => t.txId + ':' + JSON.stringify(t.record)).join(',');
  return hash(payload);
}
function pushLog(text, tone = '') {
  const stream = document.getElementById('logStream');
  if (!stream) return;
  const time = new Date().toLocaleTimeString('ja-JP');
  const p = document.createElement('p');
  p.className = tone;
  p.textContent = `[${time}] ${text}`;
  stream.insertBefore(p, stream.firstChild);
  while (stream.children.length > 50) stream.removeChild(stream.lastChild);
}

// ===== 備品 ID・選択肢 =====
const ITEM_ID_RE = /^[A-Za-z0-9._-]+$/;

function normalizeItemId(raw) {
  const id = String(raw || '').trim();
  if (!id) throw new Error('備品IDを入力してください');
  if (!ITEM_ID_RE.test(id)) {
    throw new Error('備品IDは半角英数字・ハイフン・アンダースコア・ドットのみ');
  }
  return id;
}

function syncOpTargetSelect(preferredId) {
  const sel = document.getElementById('opTarget');
  const ids = Object.keys(masterItems).sort();
  const prev = preferredId || sel.value;
  sel.innerHTML = ids.length
    ? ids.map((id) => {
      const item = masterItems[id];
      const deletedMark = String(item.status || '').toUpperCase() === 'DELETED' ? ' [削除済]' : '';
      const label = item.name && item.name !== id ? `${id} (${item.name})${deletedMark}` : `${id}${deletedMark}`;
      return `<option value="${id}">${label}</option>`;
    }).join('')
    : '<option value="">（備品を先に登録）</option>';
  if (prev && masterItems[prev]) sel.value = prev;
  else if (ids.length) sel.value = ids[ids.length - 1];
  sel.disabled = !ids.length;
  document.getElementById('btnRegularUpdate').disabled = !ids.length;
  const softDeleteBtn = document.getElementById('btnSoftDelete');
  if (softDeleteBtn) {
    const selected = masterItems[sel.value];
    softDeleteBtn.disabled = !ids.length;
  }
  document.getElementById('btnTamperMaster').disabled = !ids.length;
  document.getElementById('btnTamperPeer').disabled = !peers.some((p) => p.blocks.length);
  document.getElementById('btnTamperCouch').disabled = !peers.some((p) =>
    Object.keys(p.worldState).some((k) => k.startsWith('ITEM-')));
  updateMidBlockTamperPanel();
}

function readNewItemForm() {
  const id = normalizeItemId(document.getElementById('newItemId').value);
  const name = String(document.getElementById('newItemName').value || '').trim();
  if (!name) throw new Error('備品名を入力してください');
  return {
    id,
    name,
    category: String(document.getElementById('newItemCategory').value || '').trim() || 'その他',
    quantity: Math.max(0, Number(document.getElementById('newItemQuantity').value) || 0),
    location: String(document.getElementById('newItemLocation').value || '').trim() || '未設定',
    status: 'ACTIVE',
    version: 1,
  };
}

function clearNewItemForm(keepIdPrefix) {
  const idEl = document.getElementById('newItemId');
  const prev = idEl.value.trim();
  document.getElementById('newItemName').value = '';
  if (keepIdPrefix && prev) {
    const m = prev.match(/^([A-Za-z]+-)?(\d+)$/);
    if (m) {
      const prefix = m[1] || '';
      const next = String(Number(m[2]) + 1).padStart(m[2].length, '0');
      idEl.value = prefix + next;
    }
  }
  idEl.focus();
}

// ===== マスタ起点のドメイン操作（両シナリオで共通呼び出し） =====
async function registerItemLive() {
  let item;
  try {
    item = readNewItemForm();
  } catch (err) {
    pushLog(err.message, 'warn');
    return;
  }
  if (masterItems[item.id]) {
    pushLog(`備品「${item.id}」は既に登録されています`, 'warn');
    return;
  }
  try {
    setLiveControlsDisabled(true);
    await apiRegisterItem(item);
    await refreshWorldSnapshot({ silent: true });
    pushLog(`備品登録(API): ${item.id} (${item.name}) qty=${item.quantity}`, 'ok');
    clearNewItemForm(true);
    syncOpTargetSelect(item.id);
    scheduleAutoVerify(400);
  } catch (error) {
    pushLog(error.message || '備品登録に失敗しました', 'warn');
    // 台帳に記録できなかったときはサーバがマスタを戻しているので、表示も取り直す
    await refreshWorldSnapshot({ silent: true }).catch(() => {});
  } finally {
    setLiveControlsDisabled(false);
  }
}

function registerItem() {
  if (liveMode) {
    void registerItemLive();
    return;
  }
  let item;
  try {
    item = readNewItemForm();
  } catch (err) {
    pushLog(err.message, 'warn');
    return;
  }
  if (masterItems[item.id]) {
    pushLog(`備品「${item.id}」は既に登録されています`, 'warn');
    return;
  }
  if (activeScenario === 'c03' && !canWriteMockLedger()) {
    announceChange(
      '書込み失敗：稼働ノードが2台未満のため、台帳に記録できません（マスタは変更していません）',
      'danger',
      5200,
    );
    pushLog('書込み失敗: 稼働ノードが2台未満（合意が取れません）', 'err');
    return;
  }
  masterItems[item.id] = { ...item, _updated: true, _tampered: false, _verify: null };
  syncLocalHashStore(masterItems[item.id]);
  replicateToSlaves(item.id);
  comparisonVerified = false;

  const logId = newLogId();
  const record = {
    logId,
    eventType: 'ITEM_CREATE',
    targetId: item.id,
    userId: 'admin@org1',
    orgId: 'Org1MSP',
    note: JSON.stringify({
      af: hashItem(item),
      snap: {
        id: item.id,
        name: item.name,
        category: item.category,
        quantity: item.quantity,
        location: item.location,
        status: item.status,
      },
    }),
    timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    status: 'ACTIVE',
  };
  const itemKey = `ITEM-${item.id}`;
  const itemValue = {
    id: item.id,
    quantity: item.quantity,
    version: item.version,
    af: hashItem(item),
  };
  const { newBlocks } = appendBlockToAllPeers(record, { [itemKey]: itemValue });
  pushLog(`備品登録: ${item.id} (${item.name}) qty=${item.quantity} → 3 Peer に同期`, 'ok');
  if (activeScenario === 'c01' || activeScenario === 'c02') {
    pushLog(`帳票A・帳票B をマスタ→スレーブDB${slaveDbItems.length}台へレプリケーション`, 'ok');
  }
  syncOpTargetSelect(item.id);
  clearNewItemForm(true);
  render(() => {
    setTimeout(() => {
      newBlocks.forEach((nb, i) => {
        setTimeout(() => {
          spawnParticle(`[data-master="${item.id}"]`, `[data-block="${nb.peerId}-${nb.blockNum}"]`, 'ok', () => {
            spawnParticle(`[data-block="${nb.peerId}-${nb.blockNum}"]`, `[data-couch="${nb.peerId}"]`, 'ok');
          });
        }, i * 180);
      });
    }, 50);
  });
  document.dispatchEvent(new CustomEvent('demo:item:created', {
    detail: { id: item.id, quantity: item.quantity },
  }));
  scheduleAutoVerify(1000);
}

async function regularUpdateLive() {
  const itemId = document.getElementById('opTarget').value;
  if (!itemId || !masterItems[itemId]) {
    pushLog('更新する備品を選ぶか、先に備品を登録してください', 'warn');
    return;
  }
  const quantity = Number(document.getElementById('opQuantity').value);
  try {
    setLiveControlsDisabled(true);
    await apiRegularUpdate(itemId, quantity);
    await refreshWorldSnapshot({ silent: true });
    pushLog(`正規更新(API): ${itemId} qty=${quantity}`, 'ok');
    scheduleAutoVerify(400);
  } catch (error) {
    pushLog(error.message || '正規更新に失敗しました', 'warn');
    // 台帳に記録できなかったときはサーバがマスタを戻しているので、表示も取り直す
    await refreshWorldSnapshot({ silent: true }).catch(() => {});
  } finally {
    setLiveControlsDisabled(false);
  }
}

function regularUpdate() {
  if (liveMode) {
    void regularUpdateLive();
    return;
  }
  const itemId = document.getElementById('opTarget').value;
  if (!itemId || !masterItems[itemId]) {
    pushLog('更新する備品を選ぶか、先に備品を登録してください', 'warn');
    return;
  }
  const quantity = Number(document.getElementById('opQuantity').value);
  if (activeScenario === 'c03' && !canWriteMockLedger()) {
    announceChange(
      '書込み失敗：稼働ノードが2台未満のため、正規更新を台帳に記録できません（マスタは変更していません）',
      'danger',
      5200,
    );
    pushLog('書込み失敗: 稼働ノードが2台未満（合意が取れません）', 'err');
    return;
  }

  const beforeItem = { ...masterItems[itemId] };
  const beforeHash = hashItem(beforeItem);
  const afterItem = { ...beforeItem, quantity, version: (beforeItem.version || 0) + 1 };
  const afterHash = hashItem(afterItem);
  masterItems[itemId] = { ...afterItem, _updated: true, _tampered: false, _verify: null, _hashJustUpdated: true };
  syncLocalHashStore(masterItems[itemId]);
  replicateToSlaves(itemId);
  comparisonVerified = false;

  const logId = newLogId();
  const record = {
    logId,
    eventType: 'ITEM_UPDATE',
    targetId: itemId,
    userId: 'admin@org1',
    orgId: 'Org1MSP',
    note: JSON.stringify({
      bf: hashItem(beforeItem),
      af: hashItem(afterItem),
      snap: {
        id: afterItem.id,
        name: afterItem.name,
        category: afterItem.category,
        quantity: afterItem.quantity,
        location: afterItem.location,
        status: afterItem.status,
      },
    }),
    timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    status: 'ACTIVE',
  };
  const itemKey = `ITEM-${itemId}`;
  const itemValue = {
    id: afterItem.id,
    quantity: afterItem.quantity,
    version: afterItem.version,
    af: hashItem(afterItem),
  };
  const { newBlocks } = appendBlockToAllPeers(record, { [itemKey]: itemValue });
  pushLog(`正規更新: ${itemId}.quantity=${beforeItem.quantity}→${quantity} / hash ${beforeHash}→${afterHash}`, 'ok');
  if (activeScenario === 'c01' || activeScenario === 'c02') {
    pushLog(`帳票A（items）・帳票B（item_hashes）を更新 → スレーブ${slaveDbItems.length}台へレプリケーション`, 'ok');
  } else {
    pushLog(`正規更新: ${itemId}.quantity=${quantity} → 3 Peer に Block + CouchDB を同期`, 'ok');
  }
  render(() => {
    // 同期粒子: master → 各 peer の新ブロック → 各 CouchDB
    setTimeout(() => {
      newBlocks.forEach((nb, i) => {
        setTimeout(() => {
          spawnParticle(`[data-master="${itemId}"]`, `[data-block="${nb.peerId}-${nb.blockNum}"]`, 'ok', () => {
            spawnParticle(`[data-block="${nb.peerId}-${nb.blockNum}"]`, `[data-couch="${nb.peerId}"]`, 'ok');
          });
        }, i * 180);
      });
    }, 50);
  });
  document.dispatchEvent(new CustomEvent('demo:item:updated', {
    detail: { id: itemId, quantity },
  }));
  scheduleAutoVerify(1000);
}

async function softDeleteLive() {
  const itemId = document.getElementById('opTarget').value;
  if (!itemId || !masterItems[itemId]) {
    pushLog('削除する備品を選ぶか、先に備品を登録してください', 'warn');
    return;
  }
  try {
    setLiveControlsDisabled(true);
    await apiDeleteItem(itemId);
    await refreshWorldSnapshot({ silent: true });
    pushLog(`削除(API): ${itemId} をマスタ・ハッシュから削除し、台帳に ITEM_DELETE を追記`, 'ok');
    syncOpTargetSelect();
    scheduleAutoVerify(400);
  } catch (error) {
    pushLog(error.message || '削除に失敗しました', 'warn');
    // 台帳に記録できなかったときはサーバがマスタを戻しているので、表示も取り直す
    await refreshWorldSnapshot({ silent: true }).catch(() => {});
  } finally {
    setLiveControlsDisabled(false);
  }
}

/**
 * 削除：DB（マスタ・スレーブ・帳票B）からは行が消える。
 * Fabric は状態DB（CouchDB）からキーが消えるが、ブロックには「削除した」記録が追記され、履歴は残る。
 */
function softDelete() {
  if (liveMode) {
    void softDeleteLive();
    return;
  }
  const itemId = document.getElementById('opTarget').value;
  if (!itemId || !masterItems[itemId]) {
    pushLog('削除する備品を選ぶか、先に備品を登録してください', 'warn');
    return;
  }
  if (activeScenario === 'c03' && !canWriteMockLedger()) {
    announceChange(
      '書込み失敗：稼働ノードが2台未満のため、削除を台帳に記録できません（マスタは変更していません）',
      'danger',
      5200,
    );
    pushLog('書込み失敗: 稼働ノードが2台未満（合意が取れません）', 'err');
    return;
  }
  const beforeItem = { ...masterItems[itemId] };
  const beforeHash = hashItem(beforeItem);

  // DB 側：マスタ・スレーブ・帳票B から行を消す
  delete masterItems[itemId];
  delete localHashStore[itemId];
  slaveDbItems.forEach((slave) => { delete slave[itemId]; });
  slaveLocalHashStores.forEach((store) => { delete store[itemId]; });
  comparisonVerified = false;

  // Fabric 側：削除の記録をブロックとして追記し、状態DB からはキーを消す
  const record = {
    logId: newLogId(),
    eventType: 'ITEM_DELETE',
    targetId: itemId,
    userId: 'admin@org1',
    orgId: 'Org1MSP',
    note: JSON.stringify({ bf: beforeHash, af: '', cf: [] }),
    timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    status: 'ACTIVE',
  };
  const { newBlocks } = appendBlockToAllPeers(record);
  newBlocks.forEach((nb) => { delete peers[nb.peerId].worldState[`ITEM-${itemId}`]; });

  pushLog(`削除: ${itemId} をマスタ・スレーブ・帳票B から削除（DB には何も残らない）`, 'ok');
  pushLog(`ブロックチェーン: 削除の記録をブロック #${newBlocks[0] ? newBlocks[0].blockNum : '-'} に追記（登録・更新の履歴はブロックに残る）`, 'ok');
  if (activeScenario === 'c03') {
    announceChange(`${itemId} を削除 — 状態DBからは消え、ブロックには削除の記録が残る`, 'ok', 4600);
  }
  syncOpTargetSelect();
  render();
  document.dispatchEvent(new CustomEvent('demo:item:deleted', { detail: { id: itemId } }));
  scheduleAutoVerify(600);
}

async function tamperMasterLive() {
  const itemId = document.getElementById('opTarget').value;
  if (!itemId || !masterItems[itemId]) {
    pushLog('改ざんする備品を選択するか、先に備品を登録してください', 'warn');
    return;
  }
  const alignLocalHash = activeScenario === 'c02' && c02TamperMode === 'B';
  try {
    setLiveControlsDisabled(true);
    const result = await apiTamperMaster(itemId, { alignLocalHash });
    await refreshWorldSnapshot({ silent: true });
    pushLog(`マスタ改ざん(API): ${result.itemId} qty=${result.quantity}`, 'err');
    if (alignLocalHash || result.alignLocalHash) {
      pushLog('C-02 モードB: demo-local-hash.json も改ざん後の値に揃えました', 'warn');
    } else if (activeScenario === 'c02') {
      pushLog('C-02 モードA: 保存ハッシュは古いまま → 照合で不一致になる', 'warn');
    }
    render(() => {
      spawnParticle('#btnTamperMaster', `[data-master="${itemId}"]`, 'danger');
    });
    scheduleAutoVerify(1000);
  } catch (error) {
    pushLog(error.message || 'マスタ改ざんに失敗しました', 'warn');
  } finally {
    setLiveControlsDisabled(false);
  }
}

function tamperMaster() {
  if (liveMode) {
    void tamperMasterLive();
    return;
  }
  const itemId = document.getElementById('opTarget').value;
  if (!itemId || !masterItems[itemId]) {
    pushLog('改ざんする備品を選択するか、先に備品を登録してください', 'warn');
    return;
  }
  const item = masterItems[itemId];
  const before = item.quantity;
  item.quantity = 100;
  item._tampered = true;
  item._tamperedFromQty = before;
  item._updated = true;
  item._verify = null;
  comparisonVerified = false;
  
  // 改ざんアラートを表示
  showTamperingAlert('master');
  if (activeScenario === 'c03') {
    announceChange(
      `マスタだけを書き換え（${before} → 100）— 台帳には新しい記録がありません`,
      'danger',
      4600,
    );
  }
  if ((activeScenario === 'c02' || isAllMethodsView()) && c02TamperMode === 'B') {
    syncLocalHashStore(item, { tampered: true, skipSlaveReplicate: true });
    pushLog(`C-02 モードB: マスタの保存hash を改ざん後の値に更新（スレーブへも伝播）`, 'warn');
  }
  pushLog(`マスタ改ざん: items[${itemId}].quantity ${before} → 100（帳票A の qty が書き換わる）`, 'err');
  if (activeScenario === 'c02' && c02TamperMode === 'A') {
    pushLog(`帳票B（item_hashes）3台とも保存hash は古いまま → 照合で不一致になる`, 'warn');
  }
  // マスタ→スレーブのレプリケーションで改ざんがスレーブにも伝播する様子を演出
  if (activeScenario === 'c01' || activeScenario === 'c02') {
    render(() => {
      spawnParticle('#btnTamperMaster', `[data-master="${itemId}"]`, 'danger');
      // 少し遅らせてスレーブへ汚染が伝播
      slaveDbItems.forEach((_, idx) => {
        setTimeout(() => {
          slaveDbItems[idx][itemId] = snapshotForReplication(masterItems[itemId]);
          if (activeScenario === 'c02' && c02TamperMode === 'B' && localHashStore[itemId]) {
            slaveLocalHashStores[idx][itemId] = { ...localHashStore[itemId] };
            pushLog(`改ざん後の hash がスレーブDB${idx + 1}へレプリケーション伝播`, 'warn');
          }
          pushLog(`改ざんがスレーブDB${idx + 1}へレプリケーション伝播`, 'err');
          render(() => {
            spawnParticle(
              `[data-db-lane="master"] [data-db-row="${itemId}"]`,
              `[data-db-lane="slave${idx}"] [data-db-row="${itemId}"]`,
              'danger'
            );
            if (activeScenario === 'c02' && c02TamperMode === 'B') {
              spawnParticle(
                `[data-hash-lane="master"] [data-hash-row="${itemId}"]`,
                `[data-hash-lane="slave${idx}"] [data-hash-row="${itemId}"]`,
                'danger'
              );
            }
          });
        }, 350 + idx * 450);
      });
    });
  } else {
    if (isAllMethodsView()) {
      // 3方式比較：C-01/C-02 のスレーブにも改ざんが複製される（C-03 の台帳は書き換わらない）
      slaveDbItems.forEach((_, idx) => {
        slaveDbItems[idx][itemId] = snapshotForReplication(masterItems[itemId]);
        if (c02TamperMode === 'B' && localHashStore[itemId]) {
          slaveLocalHashStores[idx][itemId] = { ...localHashStore[itemId] };
        }
      });
      pushLog(`改ざんがスレーブDB${slaveDbItems.length}台へレプリケーション伝播（C-01/C-02）`, 'err');
    }
    render(() => {
      spawnParticle('#btnTamperMaster', `[data-master="${itemId}"]`, 'danger');
    });
  }
  document.dispatchEvent(new CustomEvent('demo:master:tampered', {
    detail: { id: itemId, quantity: item.quantity, fromQuantity: before, c02TamperMode },
  }));
  // スレーブへの伝播演出のあとに自動照合
  const verifyDelay = (activeScenario === 'c01' || activeScenario === 'c02') ? 1400 : 450;
  scheduleAutoVerify(verifyDelay);
}

async function resetLive() {
  try {
    setLiveControlsDisabled(true);
    const status = await fetchJson('/admin/api/demo/tamper-status').catch(() => ({ pending: false }));
    if (status.pending) {
      await apiRevertTamper();
      pushLog('デモ改ざんを復元しました', 'ok');
    }
    await refreshWorldSnapshot({ silent: true });
    pushLog('実データから状態を再読み込みしました', '');
  } catch (error) {
    pushLog(error.message || 'リセットに失敗しました', 'warn');
  } finally {
    setLiveControlsDisabled(false);
  }
}

function applySeedItemsLocal(items) {
  txCounter = 0;
  logCounter = 0;
  peers.forEach((p) => {
    p.blocks = [];
    p.worldState = {};
    p.tampered = false;
    p.couchTampered = false;
    p.verifyDetected = false;
  });
  masterItems = {};
  verifyDetails = [];
  localHashStore = {};
  slaveLocalHashStores = [{}, {}];
  slaveDbItems = [{}, {}];
  comparisonVerified = false;
  c02TamperMode = 'A';
  demoOverlayState = { peerId: null, blockNum: null, fakeHash: null };
  updateC02ModeSelector();
  (items || []).forEach((item) => {
    if (!item || !item.id) return;
    masterItems[item.id] = {
      ...item,
      _updated: false,
      _tampered: false,
      _verify: null,
    };
    syncLocalHashStore(masterItems[item.id]);
    replicateToSlaves(item.id);
    replicateHashToSlaves(item.id);
  });
  syncOpTargetSelect();
  render();
}

/**
 * mock: サーバの fill-plan をそのまま画面上で再生し、マスタ・ハッシュ・台帳ブロックを埋める。
 * 演出（粒子）は省き、まとめて1回描画する。
 */
function fillDemoDataLocal(steps) {
  if (activeScenario === 'c03' && !canWriteMockLedger()) {
    throw new Error('稼働ノードが2台未満のため台帳に書き込めません（ノードを復帰させてから実行してください）');
  }
  let written = 0;
  const skipped = [];
  const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  (steps || []).forEach((step) => {
    let beforeItem = null;
    let afterItem;
    let eventType;
    if (step.op === 'create') {
      const it = step.item;
      if (masterItems[it.id]) { skipped.push(it.id); return; }
      afterItem = { ...it, version: 1 };
      eventType = 'ITEM_CREATE';
    } else {
      const current = masterItems[step.id];
      if (!current) { skipped.push(step.id); return; }
      beforeItem = { ...current };
      afterItem = { ...current, version: (current.version || 1) + 1 };
      if (typeof step.delta === 'number') afterItem.quantity = Math.max(0, Number(current.quantity || 0) + step.delta);
      if (typeof step.location === 'string') afterItem.location = step.location;
      eventType = 'ITEM_UPDATE';
    }
    const clean = itemSnapshot(afterItem);
    masterItems[clean.id] = { ...afterItem, _updated: false, _tampered: false, _verify: null };
    syncLocalHashStore(masterItems[clean.id], { skipSlaveReplicate: true });
    replicateToSlaves(clean.id);
    replicateHashToSlaves(clean.id);
    const note = { af: hashItem(clean), snap: clean };
    if (beforeItem) note.bf = hashItem(beforeItem);
    const record = {
      logId: newLogId(),
      eventType,
      targetId: clean.id,
      userId: 'demo-fill@org1',
      orgId: 'Org1MSP',
      note: JSON.stringify(note),
      timestamp: stamp(),
      status: 'ACTIVE',
    };
    appendBlockToAllPeers(record, {
      [`ITEM-${clean.id}`]: { id: clean.id, quantity: clean.quantity, version: afterItem.version, af: hashItem(clean) },
    });
    written += 1;
  });
  // まとめて追加したので「新規」強調は付けない
  peers.forEach((p) => {
    p.blocks.forEach((b) => { b.isNew = false; });
    Object.values(p.worldState).forEach((kv) => { kv.updated = false; });
  });
  comparisonVerified = false;
  hideChangeSpotlight();
  if (activeScenario === 'c03' && written) {
    announceChange(`台帳にブロックを ${written} 個追加しました（デモデータ）`, 'ok', 3600);
  }
  syncOpTargetSelect();
  render();
  scheduleAutoVerify(600);
  return { written, skipped };
}

function reset() {
  if (liveMode) {
    void resetLive();
    return;
  }
  txCounter = 0;
  logCounter = 0;
  peers.forEach((p) => {
    p.blocks = [];
    p.worldState = {};
    p.tampered = false;
    p.couchTampered = false;
    p.verifyDetected = false;
  });
  masterItems = {};
  verifyDetails = [];
  localHashStore = {};
  slaveLocalHashStores = [{}, {}];
  slaveDbItems = [{}, {}];
  comparisonVerified = false;
  c02TamperMode = 'A';
  demoOverlayState = { peerId: null, blockNum: null, fakeHash: null };
  mockNodeStates = [true, true, true];
  peers.forEach((p) => { p.wasDown = false; });
  if (clearNewStateTimer) {
    clearTimeout(clearNewStateTimer);
    clearNewStateTimer = null;
  }
  hideChangeSpotlight();
  updateC02ModeSelector();
  syncOpTargetSelect();
  pushLog('リセット', '');
  render();
  if (typeof updateConnectionStatusBanner === 'function') updateConnectionStatusBanner();
  if (mockFailureMode && typeof loadNodeOpsPanel === 'function') {
    void loadNodeOpsPanel();
  } else if (typeof refreshNodeOpsStatus === 'function') {
    void refreshNodeOpsStatus();
  }
  document.dispatchEvent(new CustomEvent('demo:reset', { detail: {} }));
  if (autoVerifyTimer) {
    clearTimeout(autoVerifyTimer);
    autoVerifyTimer = null;
  }
}

// ===== 描画 エントリ =====
function render(after) {
  renderPeers();
  renderMaster();
  renderComparisonMap();
  if (typeof renderAllMethodsMap === 'function') renderAllMethodsMap();
  renderDemoStoryGuide();
  renderSvgArrows();
  window.requestAnimationFrame(() => {
    updateLayoutMetrics();
    window.requestAnimationFrame(() => {
      updateLayoutMetrics();
      if (typeof renderHashLinkOverlay === 'function') renderHashLinkOverlay();
    });
  });
  if (typeof after === 'function') requestAnimationFrame(after);
  if (clearNewStateTimer) clearTimeout(clearNewStateTimer);
  clearNewStateTimer = setTimeout(() => {
    clearNewStateTimer = null;
    peers.forEach((p) => {
      p.blocks.forEach((b) => { b.isNew = false; });
      Object.values(p.worldState).forEach((entry) => { entry.updated = false; });
    });
    const hasUpdatedMaster = Object.values(masterItems).some((item) => item._updated);
    Object.values(masterItems).forEach((v) => { v._updated = false; });
    if (hasUpdatedMaster) renderMaster();
  }, 900);
}

function renderMaster() {
  const el = document.getElementById('masterList');
  if (!el) return;
  const ids = Object.keys(masterItems);
  if (!ids.length) {
    el.innerHTML = '<div class="empty-master">まだ備品がありません。<br>操作パネルから登録すると、ここに現在のデータが表示されます。</div>';
    return;
  }
  el.innerHTML = ids.map((id) => {
    const item = masterItems[id];
    const isDeleted = String(item.status || '').toUpperCase() === 'DELETED';
    const quantityClass = item._tampered ? 'bad' : (item._updated ? 'changed' : '');
    const cls = [
      'master-item',
      item._updated ? 'is-updated' : '',
      item._tampered ? 'is-tampered' : '',
      item._verify && !item._verify.matches ? 'is-detected' : '',
      isDeleted ? 'is-deleted' : '',
    ].filter(Boolean).join(' ');
    let badge = '';
    if (item._tampered) badge = '<span class="master-badge is-attack">改ざん</span>';
    else if (isDeleted) badge = '<span class="master-badge is-deleted">削除済</span>';
    else if (item._updated) badge = '<span class="master-badge is-legit">正規更新</span>';
    let statusBox = '';
    if (item._verify) {
      const m = item._verify.matches;
      const statusText = m
        ? '✓ マスタの現在値 ↔ 台帳の監査用の値：一致'
        : '✗ マスタの現在値 ↔ 台帳の監査用の値：不一致';
      statusBox = `
            <div class="hash-mini ${m ? 'is-match' : 'is-mismatch'}">
              ${statusText}
            </div>
          `;
    }
    return `
          <div class="${cls}" data-master="${id}">
            <div class="master-field"><span class="k">備品ID</span><span class="v">${item.id}${badge}</span></div>
            <div class="master-field"><span class="k">名前</span><span class="v">${item.name || item.id}</span></div>
            <div class="master-field"><span class="k">カテゴリ</span><span class="v">${item.category || ''}</span></div>
            <div class="master-field"><span class="k">個数</span><span class="v ${quantityClass}">${item.quantity}${item._tampered && typeof item._tamperedFromQty === 'number' ? ` <span class="qty-from-label">(元: ${item._tamperedFromQty})</span>` : ''}</span></div>
            <div class="master-field"><span class="k">保管場所</span><span class="v">${item.location || ''}</span></div>
            <div class="master-field"><span class="k">状態</span><span class="v ${isDeleted ? 'is-deleted-status' : ''}">${item.status || 'ACTIVE'}</span></div>
            <div class="master-field"><span class="k">版数</span><span class="v">${item.version || 0}</span></div>
            ${statusBox}
          </div>
        `;
  }).join('');
}

// ===== 同期粒子 =====
function getElementCenter(sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function spawnParticleImpact(x, y, tone) {
  const ring = document.createElement('div');
  ring.className = 'sync-particle-impact' + (tone === 'danger' ? ' danger' : '');
  ring.style.left = `${x}px`;
  ring.style.top = `${y}px`;
  document.body.appendChild(ring);
  ring.addEventListener('animationend', () => ring.remove(), { once: true });
}

function spawnParticle(fromSel, toSel, tone, onDone) {
  const from = getElementCenter(fromSel);
  const to = getElementCenter(toSel);
  if (!from || !to) {
    onDone && onDone();
    return;
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const arcBias = Math.min(72, dist * 0.22);
  const midX = (from.x + to.x) / 2 - (dy / dist) * arcBias;
  const midY = (from.y + to.y) / 2 + (dx / dist) * arcBias;
  const duration = reducedMotion ? 250 : Math.min(1800, Math.max(1200, dist * 1.45));

  const p = document.createElement('div');
  p.className = 'sync-particle' + (tone === 'danger' ? ' danger' : '');
  p.style.left = `${from.x}px`;
  p.style.top = `${from.y}px`;
  document.body.appendChild(p);

  const finish = () => {
    spawnParticleImpact(to.x, to.y, tone);
    p.remove();
    onDone && onDone();
  };

  if (reducedMotion || typeof p.animate !== 'function') {
    p.style.transition = [
      `left ${duration}ms ease-out`,
      `top ${duration}ms ease-out`,
      `opacity ${Math.round(duration * 0.35)}ms ease-out ${Math.round(duration * 0.65)}ms`,
      `transform ${duration}ms ease-out`,
    ].join(', ');
    requestAnimationFrame(() => {
      p.style.left = `${to.x}px`;
      p.style.top = `${to.y}px`;
      p.style.opacity = '0';
      p.style.transform = 'translate(-50%, -50%) scale(0.35)';
    });
    setTimeout(finish, duration);
    return;
  }

  const anim = p.animate([
    { left: `${from.x}px`, top: `${from.y}px`, opacity: 0, transform: 'translate(-50%, -50%) scale(0.4)' },
    { left: `${from.x}px`, top: `${from.y}px`, opacity: 1, transform: 'translate(-50%, -50%) scale(0.85)', offset: 0.1 },
    { left: `${midX}px`, top: `${midY}px`, opacity: 1, transform: 'translate(-50%, -50%) scale(1.12)', offset: 0.55 },
    { left: `${to.x}px`, top: `${to.y}px`, opacity: 0.2, transform: 'translate(-50%, -50%) scale(0.45)', offset: 0.9 },
    { left: `${to.x}px`, top: `${to.y}px`, opacity: 0, transform: 'translate(-50%, -50%) scale(0.2)' },
  ], {
    duration,
    easing: 'cubic-bezier(0.18, 0.85, 0.32, 1)',
    fill: 'forwards',
  });

  anim.onfinish = finish;
}
