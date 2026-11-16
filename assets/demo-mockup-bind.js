// ==========================================================================
// demo-mockup-bind.js
//   - 全関数定義後にイベントバインド + 初期表示を行う最終スクリプト。
//   - core / c03 / c01c02 の関数を前提とするため、必ず最後に読み込む。
// ==========================================================================

document.getElementById('btnRegisterItem').addEventListener('click', registerItem);
document.getElementById('newItemId').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); registerItem(); }
});
document.getElementById('newItemName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); registerItem(); }
});
document.getElementById('btnRegularUpdate').addEventListener('click', regularUpdate);
document.getElementById('btnSoftDelete')?.addEventListener('click', softDelete);
document.getElementById('opTarget')?.addEventListener('change', () => {
  const softDeleteBtn = document.getElementById('btnSoftDelete');
  if (!softDeleteBtn) return;
  const itemId = document.getElementById('opTarget').value;
  const selected = masterItems[itemId];
  softDeleteBtn.disabled = !itemId;
});
document.getElementById('btnTamperMaster').addEventListener('click', tamperMaster);
document.getElementById('btnTamperPeer').addEventListener('click', tamperPeer);
document.getElementById('btnTamperCouch').addEventListener('click', tamperCouch);
document.getElementById('btnVerify').addEventListener('click', () => { void verifyAll(); });
document.getElementById('btnReset').addEventListener('click', reset);
document.getElementById('btnSeedDemo')?.addEventListener('click', () => { void seedDemo(); });
document.getElementById('btnResetAll')?.addEventListener('click', () => { void resetAllDemo(); });
document.getElementById('btnFillDemo')?.addEventListener('click', () => { void fillDemoDataUi(); });
document.getElementById('btnFabricReset')?.addEventListener('click', () => { void fabricResetUi(); });
document.getElementById('btnShowAllHistory')?.addEventListener('click', () => { void showAllHistory(); });
document.getElementById('btnProbeWrite')?.addEventListener('click', () => { void runNodeProbe('write'); });
document.getElementById('btnProbeRead')?.addEventListener('click', () => { void runNodeProbe('read'); });
document.getElementById('statusRefreshBtn')?.addEventListener('click', () => { void manualRefreshConnection(); });
document.getElementById('btnZoomIn')?.addEventListener('click', () => zoomMapFromToolbar(1.2));
document.getElementById('btnZoomOut')?.addEventListener('click', () => zoomMapFromToolbar(1 / 1.2));
document.getElementById('btnFitMap')?.addEventListener('click', fitMapToViewport);
document.querySelectorAll('[data-scenario-tab]').forEach((button) => {
  button.addEventListener('click', () => setActiveScenario(button.getAttribute('data-scenario-tab')));
});
document.getElementById('c02ModeSelector')?.addEventListener('change', (e) => {
  if (e.target.name !== 'c02TamperMode') return;
  c02TamperMode = e.target.value;
  render();
  scheduleAutoVerify(200);
});
// 中間ブロック改ざんは説明から省略
// document.getElementById('btnTamperMidBlock')?.addEventListener('click', simulateMidBlockTamper);
// document.getElementById('btnClearMidBlockOverlay')?.addEventListener('click', clearMidBlockOverlay);
// document.getElementById('midBlockPeer')?.addEventListener('change', updateMidBlockTamperPanel);

window.addEventListener('resize', () => updateLayoutMetrics());
bindLayoutObservers();
updateLayoutMetrics();

// 初期表示
syncOpTargetSelect();
updateScenarioLayout();
setActiveScenario('c03');
updateMethodExplainer();
applyView();
updateConnectionStatusBanner(); // 初期バナー表示
pushLog('実 API から状態を読み込み中…', '');
void Promise.resolve(bootstrapLiveData()).finally(() => { void refreshDataPrepStatus(); });
