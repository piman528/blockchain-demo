// ==========================================================================
// demo-mockup-c01c02.js
//   - C-01 (単一DB) / C-02 (DB + ローカルハッシュ) 固有のレンダリング・操作:
//     - マスタ + スレーブ2台のレーン描画 (itemsTableHtml, masterSlaveStackHtml)
//     - 帳票B: ハッシュテーブル (entryHashTableHtml / hashBookStackHtml) — マスタ+スレーブ3レーン
//     - 比較枠・台帳照合パネル (comparisonFrameHtml, ledgerComparePanelHtml)
//     - 比較カード (comparisonCardHtml, renderComparisonMap)
//   - core.js / c03.js の state / util に依存するため、それらの後に読み込む。
// ==========================================================================

function getComparisonTargetItem() {
  const selectedId = document.getElementById('opTarget')?.value;
  if (selectedId && masterItems[selectedId]) return masterItems[selectedId];
  const firstId = Object.keys(masterItems).sort()[0];
  return firstId ? masterItems[firstId] : null;
}

function comparisonCardHtml(model) {
  return `
        <article class="comparison-model-card ${model.className || ''}">
          ${model.title ? `<strong>${model.title}</strong>` : ''}
          ${model.nodeHtml || ''}
          ${model.body ? `<div>${model.body}</div>` : ''}
          ${model.expected ? `<code>${model.expected}</code>` : ''}
          ${model.current ? `<code>${model.current}</code>` : ''}
          ${model.actionHtml || ''}
        </article>
      `;
}

function getSortedItems() {
  return Object.keys(masterItems).sort().map((id) => masterItems[id]);
}

// live 時はクライアント hash()（FNV-1a・8桁）とサーバ保存値（SHA-256・64桁）で
// 算法が異なり永遠に一致しないため、帳票A「いまの値」の表示・比較には
// world-snapshot の localHashCompares（サーバ再計算値）を使う
function liveServerHashCompare(itemId) {
  if (typeof liveMode === 'undefined' || !liveMode) return null;
  if (typeof lastLocalHashCompares === 'undefined' || !Array.isArray(lastLocalHashCompares)) return null;
  return lastLocalHashCompares.find((row) => row && row.itemId === itemId) || null;
}

function currentHashForLane(item, itemForHash) {
  const serverCompare = liveServerHashCompare(item.id);
  if (serverCompare && serverCompare.currentHash) return serverCompare.currentHash;
  return hashItem(itemForHash || item);
}

function entryCurrentCellHtml(item, options = {}) {
  const role = options.role || 'master';
  const slaveIndex = options.slaveIndex;
  const itemForHash = role === 'slave' && typeof slaveIndex === 'number'
    ? (slaveDbItems[slaveIndex]?.[item.id] || item)
    : item;
  const hashStore = getHashStoreForLane(role, slaveIndex);
  const currentHash = currentHashForLane(item, itemForHash);
  const local = hashStore[item.id] || null;
  const mismatch = comparisonVerified && local && local.hash !== currentHash;
  const localMatches = local && local.hash === currentHash;
  const currentClass = [
    mismatch && comparisonVerified ? 'is-cell-detected' : '',
    comparisonVerified && localMatches ? 'is-cell-match' : '',
  ].filter(Boolean).join(' ');
  const tutorialTarget = role === 'master' ? ' data-tutorial-target="entry-current-cell"' : '';
  return `<td class="cell-current-hash ${currentClass}" data-hash-anchor="current" data-item-id="${item.id}"${tutorialTarget} title="帳票A の今の中身から計算した hash">${hashHtml(currentHash)}</td>`;
}

function hashLinkVerdict(local, currentHash) {
  if (!comparisonVerified) {
    return { state: 'pending', label: '…', stroke: '#64748b', dash: '4,4' };
  }
  if (!local) {
    return { state: 'unknown', label: '?', stroke: '#64748b', dash: '4,4' };
  }
  if (local.hash === currentHash) {
    return { state: 'match', label: '✓', stroke: '#22c55e', dash: '' };
  }
  return { state: 'mismatch', label: '✗', stroke: '#ef4444', dash: '6,4' };
}

function bookBHashCellsHtml(item, options = {}) {
  const role = options.role || 'master';
  const slaveIndex = options.slaveIndex;
  const hashStore = getHashStoreForLane(role, slaveIndex);
  const itemForHash = role === 'slave' && typeof slaveIndex === 'number'
    ? (slaveDbItems[slaveIndex]?.[item.id] || item)
    : item;
  const local = hashStore[item.id] || null;
  const currentHash = currentHashForLane(item, itemForHash);
  const mismatch = comparisonVerified && local && local.hash !== currentHash;
  const storedClass = [
    mismatch && comparisonVerified ? 'is-cell-detected' : '',
    local && local._tampered ? 'is-cell-attack' : '',
  ].filter(Boolean).join(' ');
  const tutorialTarget = role === 'master' ? ' data-tutorial-target="stored-hash-cell"' : '';
  return `
        <td class="cell-stored-hash ${storedClass}" data-hash-anchor="stored" data-item-id="${item.id}"${tutorialTarget} title="帳票B: 保存hash">${local ? hashHtml(local.hash) : '(未保存)'}</td>
      `;
}

function bookBHashHeadHtml() {
  return '<th>stored_hash</th>';
}

function qtyCellHtml(item) {
  const tamperedCell = !!item._tampered;
  const qtyLabel = tamperedCell && typeof item._tamperedFromQty === 'number'
    ? `${item.quantity} <span class="qty-from-label">(元: ${item._tamperedFromQty})</span>`
    : String(item.quantity);
  return `<td class="cell-qty ${tamperedCell ? 'is-cell-attack' : ''}"${tamperedCell ? ' data-tutorial-target="tampered-qty-cell"' : ''} title="${tamperedCell ? '書き換えられた個数' : '個数'}">${qtyLabel}</td>`;
}

function machineCardHtml(options) {
  const {
    machineKey,
    title,
    roleLabel,
    bodyHtml,
    tutorialTarget = '',
  } = options;
  const tutorialAttr = tutorialTarget ? ` data-tutorial-target="${tutorialTarget}"` : '';
  return `
        <section class="db-machine-card db-machine-${machineKey}" data-machine="${machineKey}"${tutorialAttr}>
          <header class="db-machine-head">
            <span class="db-machine-title">${title}</span>
            <span class="db-machine-role">${roleLabel}</span>
          </header>
          <div class="db-machine-body">
            ${bodyHtml}
          </div>
        </section>
      `;
}

function itemsTableHtml(selectedId, options = {}) {
  const role = options.role || 'master';
  const slaveIndex = typeof options.slaveIndex === 'number' ? options.slaveIndex : -1;
  const dataset = role === 'slave' ? (slaveDbItems[slaveIndex] || {}) : masterItems;
  const ids = Object.keys(dataset).sort();
  const items = ids.map((id) => dataset[id]);
  const masterMap = masterItems;
  const laneAttr = role === 'master' ? 'master' : `slave${slaveIndex}`;
  const showCurrentCol = activeScenario === 'c02';
  const currentHeader = showCurrentCol ? '<th>いまの値</th>' : '';
  const baseColCount = 5;
  const colCount = baseColCount + (showCurrentCol ? 1 : 0);
  const rows = items.map((item) => {
    const masterItem = masterMap[item.id];
    const divergesFromMaster = role === 'slave' && masterItem && (
      masterItem.quantity !== item.quantity ||
      masterItem.location !== item.location ||
      (masterItem.version || 0) !== (item.version || 0)
    );
    const rowClass = [
      item.id === selectedId ? 'is-selected' : '',
      divergesFromMaster ? 'is-detected' : '',
      (role === 'master' && item._verify && !item._verify.matches) ? 'is-detected' : '',
    ].filter(Boolean).join(' ');
    const currentCell = showCurrentCol ? entryCurrentCellHtml(item, { role, slaveIndex }) : '';
    return `
          <tr class="${rowClass}" data-db-row="${item.id}" data-entry-row="${item.id}">
            <td>${item.id}</td>
            <td>${item.name || item.id}</td>
            ${qtyCellHtml(item)}
            <td>${item.location || ''}</td>
            <td>${item.version || 0}</td>
            ${currentCell}
          </tr>
        `;
  }).join('');
  const headLabel = options.label || (showCurrentCol ? '帳票A: 備品データ' : '備品データ');
  const subLabel = options.subLabel || `${items.length}件`;
  return `
        <section class="db-table db-lane-${role}" data-db-lane="${laneAttr}">
          <div class="db-table-head">
            ${headLabel}
            <span>${subLabel}</span>
          </div>
          <table class="db-record-table">
            <thead>
              <tr><th>備品ID</th><th>名前</th><th>個数</th><th>場所</th><th>版数</th>${currentHeader}</tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="${colCount}">空</td></tr>`}</tbody>
          </table>
        </section>
      `;
}

function masterSlaveStackHtml(selectedId) {
  const machines = [
    {
      key: 'master',
      title: 'マシン1',
      roleLabel: 'マスタ',
      html: itemsTableHtml(selectedId, {
        role: 'master',
        label: '備品データ',
        subLabel: '書き込み元',
      }),
    },
    ...slaveDbItems.map((_, idx) => ({
      key: `slave${idx}`,
      title: `マシン${idx + 2}`,
      roleLabel: `スレーブ${idx + 1}`,
      html: itemsTableHtml(selectedId, {
        role: 'slave',
        slaveIndex: idx,
        label: '備品データ',
        subLabel: 'マスタから複製',
      }),
    })),
  ];
  const parts = [];
  machines.forEach((machine, idx) => {
    if (idx > 0) {
      parts.push('<div class="db-replicate-arrow" aria-hidden="true"><span>↓ 複製（レプリケーション）</span></div>');
    }
    parts.push(machineCardHtml({
      machineKey: machine.key,
      title: machine.title,
      roleLabel: machine.roleLabel,
      bodyHtml: machine.html,
    }));
  });
  return `<div class="db-machine-stack" data-tutorial-target="db-lane-stack">${parts.join('')}</div>`;
}

function entryHashTableHtml(selectedId, options = {}) {
  const role = options.role || 'master';
  const slaveIndex = typeof options.slaveIndex === 'number' ? options.slaveIndex : -1;
  const laneAttr = role === 'master' ? 'master' : `slave${slaveIndex}`;
  const items = getSortedItems();
  const rows = items.map((item) => {
    const hashStore = getHashStoreForLane(role, slaveIndex);
    const itemForHash = role === 'slave' && typeof slaveIndex === 'number'
      ? (slaveDbItems[slaveIndex]?.[item.id] || item)
      : item;
    const local = hashStore[item.id] || null;
    const mismatch = comparisonVerified && local && local.hash !== currentHashForLane(item, itemForHash);
    const rowClass = [
      item.id === selectedId ? 'is-selected' : '',
      item._hashJustUpdated ? 'is-recovered' : '',
      mismatch && comparisonVerified ? 'is-detected' : '',
    ].filter(Boolean).join(' ');
    return `
          <tr class="${rowClass}" data-hash-row="${item.id}">
            <td>${item.id}</td>
            ${bookBHashCellsHtml(item, { role, slaveIndex })}
          </tr>
        `;
  }).join('');
  const tableDetected = comparisonVerified && items.some((item) => {
    const hashStore = getHashStoreForLane(role, slaveIndex);
    const itemForHash = role === 'slave' && typeof slaveIndex === 'number'
      ? (slaveDbItems[slaveIndex]?.[item.id] || item)
      : item;
    const local = hashStore[item.id] || null;
    return local && local.hash !== currentHashForLane(item, itemForHash);
  });
  const headLabel = options.label || '帳票B: 保存した値';
  const subLabel = options.subLabel || `${items.length}件`;
  return `
        <section class="db-table db-book-hashes db-lane-${role} ${tableDetected ? 'is-detected' : ''}" data-hash-lane="${laneAttr}">
          <div class="db-table-head">
            ${headLabel}
            <span>${subLabel}</span>
          </div>
          <table class="db-record-table">
            <thead>
              <tr><th>備品ID</th><th>保存した値</th></tr>
            </thead>
            <tbody>${rows || '<tr><td colspan="2">空</td></tr>'}</tbody>
          </table>
        </section>
      `;
}

function machinePairBodyHtml(selectedId, role, slaveIndex) {
  const entry = itemsTableHtml(selectedId, {
    role,
    slaveIndex,
    label: '帳票A: 備品データ',
    subLabel: role === 'master' ? '書き込み元' : 'マスタから複製',
  });
  const hash = entryHashTableHtml(selectedId, {
    role,
    slaveIndex,
    label: '帳票B: 保存した値',
    subLabel: role === 'master' ? '照合用' : 'マスタから複製',
  });
  return `
        <div class="ledger-books-row">
          <div class="ledger-book ledger-book-entries">${entry}</div>
          <div class="ledger-book-bridge ledger-hash-bridge" aria-hidden="true"></div>
          <div class="ledger-book ledger-book-hashes">${hash}</div>
        </div>
      `;
}

function ledgerBooksRowHtml(selectedId) {
  const machines = [
    {
      key: 'master',
      title: 'マシン1',
      roleLabel: 'マスタ',
      body: machinePairBodyHtml(selectedId, 'master', -1),
    },
    ...slaveDbItems.map((_, idx) => ({
      key: `slave${idx}`,
      title: `マシン${idx + 2}`,
      roleLabel: `スレーブ${idx + 1}`,
      body: machinePairBodyHtml(selectedId, 'slave', idx),
    })),
  ];
  const parts = [];
  machines.forEach((machine, idx) => {
    if (idx > 0) {
      parts.push('<div class="db-replicate-arrow" aria-hidden="true"><span>↓ 複製（レプリケーション）</span></div>');
    }
    parts.push(machineCardHtml({
      machineKey: machine.key,
      title: machine.title,
      roleLabel: machine.roleLabel,
      bodyHtml: machine.body,
    }));
  });
  return `
        <div class="ledger-books-shell ledger-books-row-linked" data-tutorial-target="ledger-books-row">
          <div class="db-machine-stack" data-tutorial-target="db-lane-stack">
            ${parts.join('')}
          </div>
          <svg class="hash-link-overlay" aria-hidden="true"></svg>
        </div>
      `;
}

function hashLinkAnchorPoint(el, rowRect, side, yRatio) {
  const rect = el.getBoundingClientRect();
  const ratio = typeof yRatio === 'number' ? yRatio : 0.5;
  return {
    x: side === 'right' ? rect.right - rowRect.left : rect.left - rowRect.left,
    y: rect.top - rowRect.top + rect.height * ratio,
  };
}

function hashLinkRoutePathHtml(currentEl, storedEl, rowRect, bridge, verdict, k = 1) {
  const currentRect = currentEl.getBoundingClientRect();
  const storedRect = storedEl.getBoundingClientRect();
  const x1 = (currentRect.right - rowRect.left) / k;
  const y1 = (currentRect.top + currentRect.height / 2 - rowRect.top) / k;
  const x2 = (storedRect.left - rowRect.left) / k;
  const y2 = (storedRect.top + storedRect.height / 2 - rowRect.top) / k;
  const xBl = bridge.left;
  const xBr = bridge.right;
  const d = Math.abs(y1 - y2) < 1.5
    ? `M ${x1} ${y1} H ${xBl} H ${xBr} H ${x2}`
    : `M ${x1} ${y1} H ${xBl} V ${y2} H ${xBr} H ${x2}`;
  return `
        <path class="hash-link-path is-${verdict.state}" d="${d}"
          stroke="${verdict.stroke}" stroke-width="2.5" fill="none" stroke-dasharray="${verdict.dash}"
          stroke-linejoin="round" stroke-linecap="round"/>
        <circle class="hash-link-node" cx="${x1}" cy="${y1}" r="3" fill="${verdict.stroke}"/>
        <circle class="hash-link-node" cx="${x2}" cy="${y2}" r="3" fill="${verdict.stroke}"/>
      `;
}

function hashLinkBridgeBadgeHtml(y, verdict, options = {}) {
  const tutorialTarget = options.tutorialTarget
    ? ' data-tutorial-target="hash-compare-cell"'
    : '';
  return `<span class="hash-link-bridge-badge is-${verdict.state}"${tutorialTarget} style="top:${Math.round(y)}px;left:${Math.round(options.x)}px">${verdict.label}</span>`;
}

function hashLinkLaneConfigs() {
  const lanes = [{ laneAttr: 'master', role: 'master' }];
  slaveDbItems.forEach((_, idx) => {
    lanes.push({ laneAttr: `slave${idx}`, role: 'slave', slaveIndex: idx });
  });
  return lanes;
}

function hashLinkLaneVerdict(lane, item) {
  const hashStore = getHashStoreForLane(lane.role, lane.slaveIndex);
  const local = hashStore[item.id] || null;
  const itemForHash = lane.role === 'slave' && typeof lane.slaveIndex === 'number'
    ? (slaveDbItems[lane.slaveIndex]?.[item.id] || item)
    : item;
  return hashLinkVerdict(local, currentHashForLane(item, itemForHash));
}

function hashLinkBridgeMetrics(row, rowRect, k = 1) {
  const bridge = row.querySelector('.ledger-hash-bridge');
  if (!bridge) return null;
  const rect = bridge.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  return {
    left: (rect.left - rowRect.left) / k,
    right: (rect.right - rowRect.left) / k,
    centerX: (rect.left + rect.width / 2 - rowRect.left) / k,
  };
}

function alignLedgerBookHashes(shell) {
  // マシン単位レイアウトでは帳票A/Bが同じカード内で揃うため、全体の縦ずらしは不要
  if (!shell) return;
  shell.querySelectorAll('.ledger-book-hashes').forEach((bookB) => {
    bookB.style.transform = '';
  });
}

/**
 * 帳票A「いまの値」と帳票B「保存した値」を線と ✓ / ✗ で結ぶ。
 * C-02 タブの表示と、3方式比較マップの C-02 領域（拡大縮小される）の両方に描く。
 */
function renderHashLinkOverlay() {
  if (activeScenario === 'c02') {
    const shell = document.querySelector('#comparisonRail .ledger-books-shell.ledger-books-row-linked');
    if (shell) renderHashLinkOverlayFor(shell, { tutorial: true });
  }
  if (typeof isAllMethodsView === 'function' && isAllMethodsView()) {
    const shell = document.querySelector('#regionBodyC02 .ledger-books-shell.ledger-books-row-linked');
    if (shell) renderHashLinkOverlayFor(shell, { tutorial: false });
  }
}

function renderHashLinkOverlayFor(shell, { tutorial = false } = {}) {
  const svg = shell.querySelector('.hash-link-overlay');
  if (!svg) return;

  alignLedgerBookHashes(shell);

  const rowRect = shell.getBoundingClientRect();
  if (rowRect.width < 1 || rowRect.height < 1 || !shell.offsetWidth) return;
  // 画面上の大きさ ÷ 本来の大きさ ＝ 拡大率（マップの中では view.scale、通常表示では 1）
  const k = rowRect.width / shell.offsetWidth;

  const width = Math.ceil(shell.offsetWidth);
  const height = Math.ceil(shell.offsetHeight);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));

  const pathParts = [];
  const badgeParts = [];
  hashLinkLaneConfigs().forEach((lane) => {
    const machine = shell.querySelector(`[data-machine="${lane.laneAttr}"]`);
    if (!machine) return;
    const bridge = hashLinkBridgeMetrics(machine, rowRect, k);
    if (!bridge) return;

    getSortedItems().forEach((item) => {
      const currentEl = machine.querySelector(
        `[data-db-lane="${lane.laneAttr}"] [data-hash-anchor="current"][data-item-id="${item.id}"]`
      );
      const storedEl = machine.querySelector(
        `[data-hash-lane="${lane.laneAttr}"] [data-hash-anchor="stored"][data-item-id="${item.id}"]`
      );
      if (!currentEl || !storedEl) return;

      const localVerdict = hashLinkLaneVerdict(lane, item);
      const currentRect = currentEl.getBoundingClientRect();
      const storedRect = storedEl.getBoundingClientRect();
      const yBadge = ((currentRect.top + currentRect.height / 2 + storedRect.top + storedRect.height / 2) / 2 - rowRect.top) / k;

      pathParts.push(hashLinkRoutePathHtml(currentEl, storedEl, rowRect, bridge, localVerdict, k));
      badgeParts.push(hashLinkBridgeBadgeHtml(yBadge, localVerdict, {
        tutorialTarget: tutorial && lane.laneAttr === 'master',
        x: bridge.centerX,
      }));
    });
  });

  shell.querySelectorAll('.hash-link-badge-layer').forEach((el) => el.remove());
  if (badgeParts.length) {
    shell.insertAdjacentHTML('beforeend', `<div class="hash-link-badge-layer">${badgeParts.join('')}</div>`);
  }
  svg.innerHTML = pathParts.join('');
}

function bindHashLinkOverlayListeners() {
  if (bindHashLinkOverlayListeners._bound) return;
  bindHashLinkOverlayListeners._bound = true;
  const repaint = () => window.requestAnimationFrame(renderHashLinkOverlay);
  window.addEventListener('resize', repaint);
  const rail = document.getElementById('comparisonRail');
  if (rail) {
    rail.addEventListener('scroll', repaint, { passive: true });
  }
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(repaint);
    bindHashLinkOverlayListeners._observer = observer;
    bindHashLinkOverlayListeners._watch = (shell) => {
      if (!shell || bindHashLinkOverlayListeners._watched === shell) return;
      if (bindHashLinkOverlayListeners._watched) {
        observer.unobserve(bindHashLinkOverlayListeners._watched);
      }
      bindHashLinkOverlayListeners._watched = shell;
      observer.observe(shell);
    };
  }
}

function comparisonFrameHtml(item) {
  if (!item || activeScenario !== 'c02') return '';
  const local = localHashStore[item.id] || null;
  const currentHash = currentHashForLane(item, item);
  const localMatches = local ? local.hash === currentHash : false;
  const showFrame = comparisonVerified || item._tampered;

  if (!showFrame) return '';

  const frameClass = !comparisonVerified
    ? 'is-idle'
    : localMatches ? 'is-match' : 'is-mismatch';
  let caption = '';
  if (!comparisonVerified && item._tampered) {
    caption = '改ざん後: 帳票A の qty は変わったが、帳票B（3レーン）の stored_hash はまだ古い値のままです。';
  } else if (comparisonVerified && !localMatches) {
    caption = '保存hash（帳票B）と current（帳票A から再計算）が食い違っています → DBのみ改ざんを検知できます。';
  } else if (comparisonVerified && localMatches && item._tampered && c02TamperMode === 'B') {
    caption = '保存hash も current に合わせられているため、帳票A+B だけでは検知できません。C-03 では台帳側ハッシュは書き換えられないため、この攻撃は成立しません。';
  } else if (comparisonVerified && localMatches && item._tampered) {
    caption = '保存hash と current は一致しました。ローカルだけでは改ざんを検知できません。';
  } else if (comparisonVerified && localMatches) {
    caption = '保存hash と current が一致しています。';
  }

  return `
        <section class="compare-frame ${frameClass}" data-tutorial-target="compare-frame">
          <div class="compare-frame-head">比較枠: ${item.id} のハッシュ照合</div>
          <div class="compare-frame-body">
            <div class="compare-side">
              <span class="compare-side-label">帳票B: 保存hash</span>
              <code class="compare-value ${comparisonVerified && !localMatches ? 'is-diff' : comparisonVerified ? 'is-same' : ''}">${local ? hashHtml(local.hash) : '(未保存)'}</code>
            </div>
            <div class="compare-bridge ${comparisonVerified ? (localMatches ? 'is-match' : 'is-mismatch') : 'is-pending'}">
              ${comparisonVerified ? (localMatches ? '✓ 一致' : '✗ 不一致') : '照合前'}
            </div>
            <div class="compare-side">
              <span class="compare-side-label">DB再計算: 現在hash</span>
              <code class="compare-value ${comparisonVerified && !localMatches ? 'is-diff' : comparisonVerified ? 'is-same' : ''}">${hashHtml(currentHash)}</code>
            </div>
          </div>
          ${caption ? `<p class="compare-caption">${caption}</p>` : ''}
        </section>
      `;
}

function ledgerComparePanelHtml(item) {
  if (!item || activeScenario === 'c02') return '';
  // live 時は台帳 af（サーバの SHA-256）と比べるため、サーバ照合レポートの現在hashを使う
  const currentHash = typeof getLiveItemHash === 'function' ? getLiveItemHash(item) : hashItem(item);
  const ledgerAf = findLatestLedgerAf(peers[0], item.id);
  const ledgerSnap = findLatestLedgerSnapshot(peers[0], item.id);
  if (!ledgerAf && !item._tampered) return '';

  const ledgerMatches = ledgerAf === currentHash;
  const showPanel = item._tampered && (comparisonVerified || ledgerAf);
  if (!showPanel) return '';

  const diffRows = buildSnapshotDiffRows(ledgerSnap, itemSnapshot(item));
  const qtyDiff = diffRows.find((r) => r.key === 'quantity' && r.differs);
  const frameClass = ledgerMatches ? 'is-match' : 'is-mismatch';

  return `
        <section class="compare-frame compare-frame-ledger ${frameClass}" data-tutorial-target="compare-frame-ledger">
          <div class="compare-frame-head">監視対象: ブロックチェーン台帳（書き換え不可）</div>
          <div class="compare-frame-body">
            <div class="compare-side">
              <span class="compare-side-label">台帳 af（ITEM_UPDATE 時）</span>
              <code class="compare-value ${!ledgerMatches ? 'is-diff' : 'is-same'}">${ledgerAf ? hashHtml(ledgerAf) : '(無)'}</code>
              ${ledgerSnap ? `<span class="compare-sub">台帳 qty=${ledgerSnap.quantity}</span>` : ''}
            </div>
            <div class="compare-bridge ${ledgerMatches ? 'is-match' : 'is-mismatch'}">
              ${ledgerMatches ? '✓ 一致' : '✗ 不一致'}
            </div>
            <div class="compare-side">
              <span class="compare-side-label">現在 hash / qty</span>
              <code class="compare-value ${!ledgerMatches ? 'is-diff' : 'is-same'}">${hashHtml(currentHash)}</code>
              <span class="compare-sub">現在 qty=${item.quantity}${qtyDiff ? `（台帳は ${ledgerSnap.quantity}）` : ''}</span>
            </div>
          </div>
          <p class="compare-caption">
            ${ledgerMatches
      ? '台帳側も一致しています。'
      : 'ローカルで hash をごまかしても、台帳に残る監査 af と qty は古いまま → ここで改ざんがバレます。C-03 タブでも同じ照合が行われます。'}
          </p>
        </section>
      `;
}

function renderComparisonMap() {
  const el = document.getElementById('comparisonRail');
  if (!el) return;
  if (activeScenario === 'c03') {
    el.innerHTML = '';
    return;
  }
  const item = getComparisonTargetItem();
  if (!item) {
    el.innerHTML = `
          <article class="comparison-map-intro">
            <p class="comparison-target-line">備品を登録すると、中央に<strong>マシン3台</strong>が並びます。</p>
            <p>${activeScenario === 'c01'
        ? '複製はされますが、正しい値を別途持たないため、改ざんの検知はできません。'
        : '各マシンに帳票A（データ）と帳票B（照合用の値）が並びます。'}</p>
          </article>
        `;
    return;
  }

  const currentHash = currentHashForLane(item, item);
  const local = localHashStore[item.id] || null;
  const localMatches = local ? local.hash === currentHash : false;

  const singleDbModel = {
    title: '',
    className: comparisonVerified ? 'is-weak' : 'is-idle',
    nodeHtml: `
          <div class="db-structure">
            ${masterSlaveStackHtml(item.id)}
          </div>
        `,
  };

  let c02ClassName;
  if (!comparisonVerified) {
    c02ClassName = 'is-idle';
  } else if (!localMatches) {
    c02ClassName = 'is-detected';
  } else if (c02TamperMode === 'B' && item._tampered) {
    c02ClassName = 'is-weak';
  } else if (item._tampered && local && local._tampered) {
    c02ClassName = 'is-weak';
  } else {
    c02ClassName = 'is-detected';
  }

  const localHashModel = {
    title: '',
    className: c02ClassName,
    nodeHtml: `
          <div class="db-structure">
            ${ledgerBooksRowHtml(item.id)}
          </div>
        `,
  };

  const activeModel = activeScenario === 'c01' ? singleDbModel : localHashModel;

  el.innerHTML = comparisonCardHtml(activeModel);

  bindHashLinkOverlayListeners();
  window.requestAnimationFrame(() => {
    const shell = document.querySelector('.ledger-books-shell.ledger-books-row-linked');
    if (typeof bindHashLinkOverlayListeners._watch === 'function') {
      bindHashLinkOverlayListeners._watch(shell);
    }
    renderHashLinkOverlay();
    window.requestAnimationFrame(renderHashLinkOverlay);
  });

  if (item._hashJustUpdated) {
    setTimeout(() => {
      delete masterItems[item.id]._hashJustUpdated;
    }, 1200);
  }
}

// ==========================================================================
// 3方式比較（同じマップ上に C-01 / C-02 / C-03 を並べる）
//   C-03 のレーンはそのまま使い、その下に C-01・C-02 の領域を描く。
//   データ（マスタ・スレーブ・ハッシュ・ブロック）は3方式で共有しているので、
//   右パネルの登録・正規更新・改ざんは3方式に同時にかかる。
// ==========================================================================

function anyTamperedItem() {
  return Object.values(masterItems).some((item) => item._tampered);
}

function methodVerdicts() {
  const tampered = anyTamperedItem();

  // C-01：照合の基準を持たない
  const c01 = tampered
    ? { cls: 'is-pass', text: 'すり抜けた', note: '3台とも書き換え後の値で揃い、正しい値を確かめる基準がない' }
    : { cls: '', text: '基準なし', note: '3台は同じ値。ただし正しさを確かめる手段はない' };

  // C-02：保存したハッシュ（帳票B）と今の値を比べる
  let c02;
  if (!comparisonVerified) {
    c02 = { cls: '', text: '未照合', note: '照合すると帳票A と帳票B を比べる' };
  } else {
    const mismatch = Object.values(masterItems).some((item) => {
      const local = localHashStore[item.id];
      return local && local.hash !== currentHashForLane(item, item);
    });
    if (mismatch) c02 = { cls: 'is-caught', text: '検知した', note: '帳票B に保存した値と今の値が一致しない' };
    else if (tampered) c02 = { cls: 'is-pass', text: 'すり抜けた', note: '帳票B も同じ組織の中で書き換えられた' };
    else c02 = { cls: 'is-ok', text: '一致', note: '帳票A と帳票B は一致' };
  }

  // C-03：台帳（他の組織も持つ）と比べる
  let c03;
  const details = Array.isArray(verifyDetails) ? verifyDetails : [];
  if (details.some((d) => d && d.title === '照合できません')) {
    c03 = { cls: 'is-cannot', text: '照合できない', note: '稼働しているノードがない' };
  } else if (!comparisonVerified) {
    c03 = { cls: '', text: '未照合', note: '照合すると台帳の値と比べる' };
  } else if (details.some((d) => d && d.matches === false)) {
    c03 = { cls: 'is-caught', text: '検知した', note: '台帳に記録された値とマスタが一致しない' };
  } else {
    c03 = { cls: 'is-ok', text: '一致', note: 'マスタと台帳は一致' };
  }
  return { c01, c02, c03 };
}

function methodRegionHeadHtml(code, name, basis, verdict) {
  return `
        <span class="method-region-code">${code}</span>
        <span class="method-region-name">${name}</span>
        <span class="method-region-basis">照合の基準：${basis}</span>
        <span class="method-verdict ${verdict.cls}">${verdict.text}</span>
      `;
}

const COMPARE_LANE_GAP = 36;
const COMPARE_LANE_TOP = 64;

/** 3方式比較：Fabric の各レーンを中身の高さに合わせて上から積み、その下に C-01/C-02 を置く */
function layoutCompareLanes() {
  if (!isAllMethodsView()) return;
  let y = COMPARE_LANE_TOP;
  [0, 1, 2].forEach((i) => {
    const lane = document.getElementById(`peerLane${i}`);
    if (!lane) return;
    if (lane.dataset.origTop === undefined) lane.dataset.origTop = lane.style.top;
    lane.style.top = `${y}px`;
    y += lane.offsetHeight + COMPARE_LANE_GAP;
  });
  const row = document.getElementById('allMethodsRow');
  if (row) row.style.top = `${y + 40}px`;
  if (typeof renderSvgArrows === 'function') renderSvgArrows();
  if (typeof renderHashLinkOverlay === 'function') renderHashLinkOverlay();
}

function restoreCompareLaneLayout() {
  [0, 1, 2].forEach((i) => {
    const lane = document.getElementById(`peerLane${i}`);
    if (lane && lane.dataset.origTop !== undefined) {
      lane.style.top = lane.dataset.origTop;
      delete lane.dataset.origTop;
    }
  });
}

function renderAllMethodsMap() {
  const body01 = document.getElementById('regionBodyC01');
  const body02 = document.getElementById('regionBodyC02');
  const head01 = document.getElementById('regionHeadC01');
  const head02 = document.getElementById('regionHeadC02');
  const head03 = document.getElementById('regionHeadC03');
  if (!body01 || !body02) return;
  if (!isAllMethodsView()) {
    body01.innerHTML = '';
    body02.innerHTML = '';
    restoreCompareLaneLayout();
    return;
  }

  const v = methodVerdicts();
  head01.innerHTML = methodRegionHeadHtml('C-01', '単一DB', 'なし', v.c01);
  head02.innerHTML = methodRegionHeadHtml('C-02', 'DB＋ハッシュ', '同じ組織の帳票B', v.c02);
  head03.innerHTML = methodRegionHeadHtml('C-03', 'ブロックチェーン', '3台の台帳（他の組織も持つ）', v.c03);

  const item = getComparisonTargetItem();
  if (!item) {
    const empty = '<p class="method-region-empty">備品を登録すると、ここにマシン3台が並びます。</p>';
    body01.innerHTML = empty;
    body02.innerHTML = empty;
    layoutCompareLanes();
    return;
  }

  // 表の列（帳票A の「いまの値」など）は activeScenario を見て出し分けているので、一時的に切り替えて描く
  const prev = activeScenario;
  const sharedSlaves = slaveDbItems;
  try {
    activeScenario = 'c01';
    if (c01SlaveDbItems) slaveDbItems = c01SlaveDbItems;
    body01.innerHTML = `<div class="db-structure">${masterSlaveStackHtml(item.id)}</div>`;
    slaveDbItems = sharedSlaves;
    activeScenario = 'c02';
    body02.innerHTML = `<div class="db-structure">${ledgerBooksRowHtml(item.id)}</div>`;
  } finally {
    activeScenario = prev;
    slaveDbItems = sharedSlaves;
  }
  // 文字を大きくした分レーンの高さが変わるので、縦位置を詰め直す（レーンは render() で先に描かれている）
  layoutCompareLanes();
}
