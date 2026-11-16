/*
 * 台帳マップ画面の「3方式比較」タブ。
 * C-03 のズームできるマップの上に C-01 / C-02 の領域も表示し、
 * 右パネルの操作（登録・正規更新・改ざん・照合）を3方式に同時にかける。
 * 描画は renderAllMethodsMap()（demo-mockup-c01c02.js）。
 */
(function () {
  'use strict';
  const btn = document.getElementById('btnCompareView');
  if (!btn) return;
  const titleEl = document.getElementById('scenarioTitle');

  function setCompareView(on) {
    if (on) {
      // 操作の意味（ノード障害・台帳への記録）は C-03 を基準にする
      if (typeof setActiveScenario === 'function' && activeScenario !== 'c03') setActiveScenario('c03');
      document.body.dataset.compareView = 'on';
      document.querySelectorAll('[data-scenario-tab]').forEach((b) => {
        b.classList.remove('is-active');
        b.setAttribute('aria-pressed', 'false');
      });
      if (titleEl) titleEl.textContent = '3方式を同じマップで比較';
      // C-03 表示中はスレーブ側のハッシュを複製していないので、ここで揃える
      if (typeof replicateAllToSlaves === 'function') replicateAllToSlaves();
      Object.keys(masterItems || {}).forEach((id) => {
        if (typeof replicateHashToSlaves === 'function') replicateHashToSlaves(id);
      });
    } else {
      delete document.body.dataset.compareView;
    }
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', String(on));
    if (typeof updateC02ModeSelector === 'function') updateC02ModeSelector();
    if (typeof render === 'function') render();
    if (on) {
      if (typeof scheduleAutoVerify === 'function') scheduleAutoVerify(300);
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (typeof fitMapToViewport === 'function') fitMapToViewport();
      }));
    }
  }

  btn.addEventListener('click', () => setCompareView(true));

  // Fabric レーンの「すべて表示 / 最新8個に戻す」
  const world = document.getElementById('mapWorld');
  if (world) {
    world.addEventListener('mousedown', (e) => {
      // ボタンを押すときはマップのドラッグ移動を始めない
      if (e.target.closest('[data-blocks-toggle]')) e.stopPropagation();
    });
    world.addEventListener('click', (e) => {
      const t = e.target.closest('[data-blocks-toggle]');
      if (!t) return;
      compareShowAllBlocks = t.dataset.blocksToggle === 'expand';
      if (typeof render === 'function') render();
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (typeof fitMapToViewport === 'function') fitMapToViewport();
      }));
    });
  }
  // 既存の方式タブを押したら、比較表示を閉じて通常の台帳マップに戻る
  document.querySelectorAll('[data-scenario-tab]').forEach((b) => {
    b.addEventListener('click', () => setCompareView(false), true);
  });
})();
