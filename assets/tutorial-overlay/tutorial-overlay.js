// tutorial-overlay.js — オーバーレイ本体（環境非依存）
const TutorialOverlay = (function () {
  let steps = [];
  let currentIndex = 0;
  let root = null;
  let calloutEl = null;
  let modalEl = null;
  let activeWaitCleanup = null;
  let resizeHandler = null;
  let scrollHandler = null;
  let mutationObserver = null;
  let highlightRefreshScheduled = false;
  let spotlightPool = [];
  let stepPhase = 'initial';
  let isActive = false;

  function getEnv() {
    return window.TutorialEnvironment || {};
  }

  function getStep() {
    return steps[currentIndex] || null;
  }

  function progressLabel() {
    const actionSteps = steps.filter((s) => !s.kind || s.kind === 'action');
    const actionIndex = steps.slice(0, currentIndex + 1).filter((s) => !s.kind || s.kind === 'action').length;
    return `${actionIndex} / ${actionSteps.length}`;
  }

  function teardownWait() {
    if (typeof activeWaitCleanup === 'function') {
      activeWaitCleanup();
      activeWaitCleanup = null;
    }
  }

  /** C-03: ステップ切替時にマップを自動スクロールしない */
  function skipAutoScrollForScenario() {
    return document.body.dataset.scenario === 'c03';
  }

  function placeCalloutDocked() {
    if (!calloutEl) return;
    const margin = 12;
    const viewportW = document.documentElement.clientWidth || window.innerWidth;
    const viewportH = window.innerHeight;
    const isStacked = window.matchMedia('(max-width: 900px)').matches;
    const main = document.querySelector('.mockup-main');
    const mainRect = main?.getBoundingClientRect();
    const footer = document.querySelector('.mockup-br-dock');
    const footerRect = footer?.getBoundingClientRect();
    // デスクトップでは中央ペイン内、縦積み画面ではビューポート下端に置く。
    // フッターが全幅でも、その幅を右側の余白として差し引かない。
    const useMainBounds = !isStacked && mainRect && mainRect.width > margin * 2;
    const leftEdge = useMainBounds ? Math.max(margin, mainRect.left + margin) : margin;
    const rightEdge = useMainBounds ? Math.min(viewportW - margin, mainRect.right - margin) : viewportW - margin;
    const maxWidth = Math.max(0, Math.min(760, rightEdge - leftEdge));
    const left = leftEdge + Math.max(0, (rightEdge - leftEdge - maxWidth) / 2);
    const footerTop = !isStacked && footerRect && footerRect.top > 0
      ? Math.min(viewportH, footerRect.top)
      : viewportH;
    const lowerEdge = useMainBounds ? Math.min(viewportH, mainRect.bottom, footerTop) : viewportH;
    const bottom = Math.max(margin, viewportH - lowerEdge + margin);
    const upperEdge = useMainBounds ? Math.max(margin, mainRect.top + margin) : margin;
    const availableHeight = Math.max(0, viewportH - bottom - upperEdge);
    const sharedH = Math.min(200, Math.max(140, Math.floor(viewportH * 0.26)), availableHeight);

    document.body.style.setProperty('--tutorial-dock-w', `${maxWidth}px`);
    document.body.style.setProperty('--tutorial-shared-h', `${sharedH}px`);
    document.body.style.removeProperty('--tutorial-inset-top');

    calloutEl.classList.add('is-docked');
    calloutEl.style.left = `${left}px`;
    calloutEl.style.right = 'auto';
    calloutEl.style.top = 'auto';
    calloutEl.style.bottom = `${bottom}px`;
    calloutEl.style.width = `${maxWidth}px`;
    calloutEl.style.maxWidth = `${maxWidth}px`;
    calloutEl.style.height = `${sharedH}px`;
    calloutEl.style.maxHeight = `${sharedH}px`;
    calloutEl.style.transform = 'none';
    calloutEl.dataset.arrow = 'none';

    window.requestAnimationFrame(() => {
      if (typeof updateLayoutMetrics === 'function') updateLayoutMetrics();
      if (typeof renderHashLinkOverlay === 'function') {
        window.requestAnimationFrame(renderHashLinkOverlay);
      }
    });
  }

  function scrollStepTargetsIntoView(targets) {
    if (!targets?.length) return;
    const isStacked = window.matchMedia('(max-width: 900px)').matches;
    if (!isStacked && skipAutoScrollForScenario()) return;
    if (isStacked) {
      // 縦積みでは操作欄と図が別の画面になるため、操作対象を1つだけ優先する。
      // 最後の図まで続けてスクロールすると、押すべきボタンが画面外に戻ってしまう。
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const elements = [...getHighlightTargets(getStep()), ...targets]
        .map((selector) => document.querySelector(selector))
        .filter(isVisible);
      const actionSelector = 'button, input:not([type="hidden"]), select, textarea, [role="button"]';
      const action = elements
        .map((el) => el.matches(actionSelector) ? el : el.querySelector(actionSelector))
        .find(isVisible);
      let target = action || elements[0];
      const map = document.getElementById('mapStage');
      // 図の内部はパン・ズームで移動する。ページだけをスクロールして図へ戻す。
      if (!action && target && map?.contains(target)) target = map;
      target?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      if (typeof renderHashLinkOverlay === 'function') {
        window.requestAnimationFrame(renderHashLinkOverlay);
      }
      return;
    }
    const rail = document.getElementById('comparisonRail');
    for (const target of targets) {
      const el = document.querySelector(target);
      if (!el) continue;
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      if (rail && rail.contains(el)) break;
    }
    if (typeof renderHashLinkOverlay === 'function') {
      window.requestAnimationFrame(renderHashLinkOverlay);
    }
  }

  function getHighlightTargets(step) {
    const initialTargets = step?.highlights || step?.scrollTargets || [];
    const completedTargets = step?.waitFor?.afterHighlights || step?.waitFor?.afterScrollTargets;
    return stepPhase === 'completed' && completedTargets ? completedTargets : initialTargets;
  }

  function collectHighlightRects(selectors) {
    const rects = [];
    const seen = new Set();
    const padding = 6;

    (selectors || []).forEach((selector) => {
      let elements = [];
      try {
        elements = document.querySelectorAll(selector);
      } catch (_) {
        return;
      }

      elements.forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);

        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;

        const rect = el.getBoundingClientRect();
        const left = Math.max(0, rect.left - padding);
        const top = Math.max(0, rect.top - padding);
        const right = Math.min(window.innerWidth, rect.right + padding);
        const bottom = Math.min(window.innerHeight, rect.bottom + padding);
        if (right <= left || bottom <= top) return;

        rects.push({
          left,
          top,
          width: right - left,
          height: bottom - top,
        });
      });
    });

    return rects;
  }

  function clearHighlights() {
    spotlightPool.forEach((spotlight) => spotlight.remove());
    spotlightPool = [];
  }

  function applyHighlights(selectors) {
    if (!root) return;

    const rects = collectHighlightRects(selectors);
    while (spotlightPool.length > rects.length) {
      spotlightPool.pop().remove();
    }

    rects.forEach((rect, index) => {
      let spotlight = spotlightPool[index];
      if (!spotlight) {
        spotlight = document.createElement('div');
        spotlight.className = 'tutorial-spotlight is-pulse';
        spotlight.setAttribute('aria-hidden', 'true');
        root.appendChild(spotlight);
        spotlightPool.push(spotlight);
      }

      Object.assign(spotlight.style, {
        left: `${Math.round(rect.left)}px`,
        top: `${Math.round(rect.top)}px`,
        width: `${Math.ceil(rect.width)}px`,
        height: `${Math.ceil(rect.height)}px`,
      });
    });
  }

  function scheduleHighlightRefresh() {
    if (!isActive || highlightRefreshScheduled) return;
    highlightRefreshScheduled = true;
    window.requestAnimationFrame(() => {
      highlightRefreshScheduled = false;
      const step = getStep();
      if (!step || step.kind === 'modal') {
        clearHighlights();
        return;
      }
      applyHighlights(getHighlightTargets(step));
    });
  }

  function setNextVisible(visible) {
    const nextBtn = root?.querySelector('.tutorial-next');
    if (!nextBtn) return;
    nextBtn.hidden = !visible;
    if (visible) {
      calloutEl?.querySelector('.tutorial-actions')?.scrollIntoView({ block: 'nearest' });
    }
  }

  function updateCalloutContent(step, extraBody) {
    if (!calloutEl) return;
    calloutEl.classList.add('is-docked');
    calloutEl.innerHTML = `
      <div class="tutorial-callout-arrow"></div>
      <div class="tutorial-callout-body">
        <div class="tutorial-callout-scroll">
          <div class="tutorial-step-meta">
            <span class="tutorial-chapter">${step.chapter || ''}</span>
            <span class="tutorial-progress">${progressLabel()}</span>
          </div>
          <h3 class="tutorial-step-title">${step.title || ''}</h3>
          <p class="tutorial-step-body">${extraBody || step.body || ''}</p>
        </div>
        <div class="tutorial-actions">
          <button class="tutorial-skip" type="button">スキップ</button>
          <button class="tutorial-prev" type="button">← 戻る</button>
          <button class="tutorial-next" type="button" hidden>次へ →</button>
        </div>
      </div>
    `;
    calloutEl.querySelector('.tutorial-skip')?.addEventListener('click', () => stop());
    calloutEl.querySelector('.tutorial-prev')?.addEventListener('click', () => prev());
    calloutEl.querySelector('.tutorial-next')?.addEventListener('click', () => next());
    placeCalloutDocked();
  }

  function renderSummaryModal(step) {
    modalEl.innerHTML = `
      <div class="tutorial-modal-body tutorial-modal-summary">
        <h2>${step.title}</h2>
        ${step.body ? `<p>${step.body}</p>` : ''}
        <div class="tutorial-summary-table-wrap">
          <table class="tutorial-summary-table">
            <thead>
              <tr>
                <th>方法</th>
                <th>備品の内容だけを<br>勝手に変えたとき</th>
                <th>内容と確認用の数字を<br>一緒に変えたとき</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>C-01 3台で同じ内容を持つ</td><td>気づけない</td><td>気づけない</td></tr>
              <tr><td>C-02 確認用の数字も持つ</td><td>気づける</td><td>気づけない</td></tr>
              <tr><td>C-03 別の場所にも記録を残す</td><td>気づける</td><td><strong>気づける</strong></td></tr>
            </tbody>
          </table>
        </div>
        <div class="tutorial-modal-actions">
          <button class="tutorial-restart" type="button">もう一度</button>
          <button class="tutorial-finish" type="button">自由に試す</button>
        </div>
      </div>
    `;
    modalEl.hidden = false;
    modalEl.querySelector('.tutorial-restart')?.addEventListener('click', async () => {
      await getEnv().reset();
      goTo(0);
    });
    modalEl.querySelector('.tutorial-finish')?.addEventListener('click', () => stop());
  }

  function renderModal(step) {
    if (step.summary) {
      renderSummaryModal(step);
      return;
    }
    modalEl.innerHTML = `
      <div class="tutorial-modal-body">
        <h2>${step.title || ''}</h2>
        <p>${step.body || ''}</p>
        <div class="tutorial-modal-actions">
          <button class="tutorial-modal-next" type="button">${step.modalButton || '次へ'}</button>
        </div>
      </div>
    `;
    modalEl.hidden = false;
    modalEl.querySelector('.tutorial-modal-next')?.addEventListener('click', () => next());
  }

  function setupWaitFor(step) {
    teardownWait();
    const wait = step.waitFor;
    if (!wait) {
      setNextVisible(true);
      return;
    }

    setNextVisible(false);

    if (wait.manual) {
      setNextVisible(true);
      return;
    }

    if (wait.delayMs) {
      const timer = window.setTimeout(() => setNextVisible(true), wait.delayMs);
      activeWaitCleanup = () => window.clearTimeout(timer);
      return;
    }

    const env = getEnv();
    const advance = () => {
      if (wait.manualAdvance) {
        stepPhase = 'completed';
        if (wait.afterBody) updateCalloutContent(step, wait.afterBody);
        scrollStepTargetsIntoView(wait.afterScrollTargets || step.scrollTargets);
        scheduleHighlightRefresh();
        setNextVisible(true);
        return;
      }
      next();
    };

    const handler = (e) => {
      if (wait.filter && !wait.filter(e)) return;
      teardownWait();
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(advance);
      });
    };

    if (wait.event === 'change' && wait.target) {
      const el = document.querySelector(wait.target);
      if (!el) {
        setNextVisible(true);
        return;
      }
      el.addEventListener('change', handler);
      activeWaitCleanup = () => el.removeEventListener('change', handler);
      return;
    }

    env.on(wait.event, handler);
    activeWaitCleanup = () => env.off(wait.event, handler);
  }

  function enterStep(index) {
    currentIndex = index;
    stepPhase = 'initial';
    const step = getStep();
    if (!step) {
      stop();
      return;
    }

    teardownWait();

    const runEnter = async () => {
      if (step.scenario && typeof getEnv().setScenario === 'function') {
        getEnv().setScenario(step.scenario);
      }

      if (typeof step.onEnter === 'function') {
        await step.onEnter();
      }

      if (step.kind === 'modal') {
        if (calloutEl) calloutEl.hidden = true;
        clearHighlights();
        renderModal(step);
        return;
      }

      modalEl.hidden = true;
      if (calloutEl) calloutEl.hidden = false;

      updateCalloutContent(step);
      window.requestAnimationFrame(() => {
        setupWaitFor(step);
        scrollStepTargetsIntoView(step.scrollTargets);
        scheduleHighlightRefresh();
      });
    };

    runEnter();
  }

  function goTo(index) {
    if (index < 0 || index >= steps.length) return;
    enterStep(index);
  }

  function next() {
    if (currentIndex >= steps.length - 1) {
      stop();
      return;
    }
    goTo(currentIndex + 1);
  }

  function prev() {
    if (currentIndex <= 0) return;
    goTo(currentIndex - 1);
  }

  function buildDom() {
    root = document.createElement('div');
    root.className = 'tutorial-root';
    root.dataset.tutorialActive = 'true';
    root.innerHTML = `
      <div class="tutorial-callout" hidden></div>
      <div class="tutorial-modal" hidden></div>
    `;
    document.body.appendChild(root);
    calloutEl = root.querySelector('.tutorial-callout');
    modalEl = root.querySelector('.tutorial-modal');
  }

  function bindObservers() {
    resizeHandler = () => {
      placeCalloutDocked();
      scheduleHighlightRefresh();
    };
    scrollHandler = () => scheduleHighlightRefresh();
    window.addEventListener('resize', resizeHandler);
    window.addEventListener('scroll', scrollHandler, true);

    const observeTargets = [
      document.querySelector('.mockup-main'),
      document.querySelector('.mockup-controls'),
      document.querySelector('.mockup-dock'),
      document.querySelector('.mockup-header'),
      document.getElementById('comparisonRail'),
    ].filter(Boolean);

    mutationObserver = new MutationObserver((mutations) => {
      const hasRelevantMutation = mutations.some((mutation) => {
        const target = mutation.target instanceof Element
          ? mutation.target
          : mutation.target.parentElement;
        return target && !target.closest('.tutorial-root');
      });
      if (hasRelevantMutation) scheduleHighlightRefresh();
    });
    observeTargets.forEach((target) => {
      mutationObserver.observe(target, { childList: true, subtree: true });
    });
  }

  function unbindObservers() {
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    if (resizeHandler) {
      window.removeEventListener('resize', resizeHandler);
      resizeHandler = null;
    }
    if (scrollHandler) {
      window.removeEventListener('scroll', scrollHandler, true);
      scrollHandler = null;
    }
    highlightRefreshScheduled = false;
    clearHighlights();
  }

  async function start(stepList) {
    if (isActive) stop();
    steps = stepList || [];
    if (!steps.length) return;

    buildDom();
    bindObservers();
    isActive = true;
    document.body.classList.add('tutorial-active');

    await getEnv().reset();
    if (steps[0].scenario) getEnv().setScenario(steps[0].scenario);

    window.requestAnimationFrame(() => enterStep(0));
  }

  function stop() {
    teardownWait();
    unbindObservers();
    if (root) root.remove();
    root = null;
    calloutEl = null;
    modalEl = null;
    isActive = false;
    steps = [];
    currentIndex = 0;
    stepPhase = 'initial';
    document.body.classList.remove('tutorial-active');
    document.body.style.removeProperty('--tutorial-inset-top');
    document.body.style.removeProperty('--tutorial-dock-w');
    document.body.style.removeProperty('--tutorial-shared-h');
    if (typeof updateLayoutMetrics === 'function') updateLayoutMetrics();
  }

  return {
    start,
    stop,
    next,
    prev,
    goTo,
    isActive: () => isActive,
  };
})();

window.TutorialOverlay = TutorialOverlay;

window.initTutorialIfEnabled = function initTutorialIfEnabled() {
  if (typeof installMockupTutorialEnvironment === 'function') {
    installMockupTutorialEnvironment();
  }
  const params = new URLSearchParams(window.__staticSearch != null ? window.__staticSearch : window.location.search);
  if (params.get('tutorial') === '0') return;
  // 読み込み中に 3方式比較を開いていたら、チュートリアルは始めない（比較表示では非表示にしている）
  if (document.body.dataset.compareView === 'on') return;
  if (typeof TUTORIAL_STEPS_MOCKUP !== 'undefined') {
    TutorialOverlay.start(TUTORIAL_STEPS_MOCKUP);
  }
};
