// tutorial-environment.js — 環境抽象化（モック/本番のアダプタ差し替え用）
(function () {
  const noop = async () => null;

  window.TutorialEnvironment = {
    kind: 'none',
    async getItem() { return null; },
    async getItemHash() { return null; },
    async getLedgerAf() { return null; },
    on(eventName, handler) {
      document.addEventListener(eventName, handler);
    },
    off(eventName, handler) {
      document.removeEventListener(eventName, handler);
    },
    async reset() { noop(); },
    setScenario() { /* no-op */ },
  };

  window.installMockupTutorialEnvironment = function installMockupTutorialEnvironment() {
    window.TutorialEnvironment = {
      kind: 'mockup',
      async getItem(id) {
        return typeof masterItems !== 'undefined' ? (masterItems[id] || null) : null;
      },
      async getItemHash(id) {
        return typeof localHashStore !== 'undefined' ? (localHashStore[id]?.hash || null) : null;
      },
      async getLedgerAf(id) {
        if (typeof peers === 'undefined' || typeof findLatestLedgerAf !== 'function') return null;
        return findLatestLedgerAf(peers[0], id) || null;
      },
      on(eventName, handler) {
        document.addEventListener(eventName, handler);
      },
      off(eventName, handler) {
        document.removeEventListener(eventName, handler);
      },
      async reset() {
        if (typeof reset === 'function') reset();
      },
      setScenario(name) {
        // 3方式比較を開いている間は、チュートリアルが方式タブを切り替えない
        if (document.body.dataset.compareView === 'on') return;
        if (typeof setActiveScenario === 'function') setActiveScenario(name);
      },
    };
  };
})();
