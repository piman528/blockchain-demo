// ==========================================================================
// demo-mockup-api.js
//   - 実 API との通信レイヤ（Phase 1: world-snapshot / 備品 CRUD / 改ざん / 整合性）
//   - core.js の state を hydrate する。失敗時は liveMode=false でフォールバック。
// ==========================================================================

    let liveMode = false;
    let liveBusy = false;
    let lastIntegrityReport = null;
    let lastWorldWarnings = [];
    let lastConnection = null;
    let lastLocalHashCompares = [];
    let lastFetchedAt = null;
    let lastItemCount = 0;
    let lastAuditLogCount = 0;
    let lastTamperInfo = { pending: false, items: [] };
    let connectionPollTimer = null;
    // サーバが起動時に指定した DEMO_MODE（auto / mock / live）。
    // /admin/api/demo/mode から取得できなかった場合は 'auto' として扱う。
    let demoModeSetting = 'auto';
    let liveModeState = 'loading'; // 'loading' | 'live' | 'fallback' | 'mock-forced' | 'live-error'
    let lastSnapshotError = null;
    // Live で取得した実ブロックの情報（高さ・省略したブロック数など）。null なら説明用の表示
    let realChainMeta = null;

    const API_FETCH_TIMEOUT_MS = 12000;
    const CONNECTION_POLL_MS = 15000;
    
    // 接続状態バナー用の変数
    let previousNodeStates = new Map(); // ノードID -> 前回の稼働状態
    let connectionStatusInitialized = false;

    // core.js を読み込まない単体テストでも動くように、状態はヘルパー経由で参照する。
    function isMockFailureMode() {
      return typeof mockFailureMode !== 'undefined' && Boolean(mockFailureMode);
    }

    function getMockNodeStates() {
      return typeof mockNodeStates !== 'undefined' && Array.isArray(mockNodeStates)
        ? mockNodeStates
        : [true, true, true];
    }

    async function fetchJson(url, options = {}) {
      const { timeoutMs = API_FETCH_TIMEOUT_MS, ...fetchOptions } = options;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || `API error (${res.status})`);
        }
        return data;
      } catch (error) {
        if (error.name === 'AbortError') {
          throw new Error(`API がタイムアウトしました (${timeoutMs}ms)`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    function setLiveControlsDisabled(disabled) {
      liveBusy = disabled;
      const ids = [
        'btnRegisterItem', 'btnRegularUpdate', 'btnSoftDelete', 'btnTamperMaster',
        'btnVerify', 'btnReset', 'btnTamperPeer', 'btnTamperCouch',
        'btnTamperMidBlock', 'btnClearMidBlockOverlay',
        'btnSeedDemo', 'btnProbeWrite', 'btnProbeRead',
        'btnResetAll', 'btnFillDemo', 'btnShowAllHistory', 'fillRounds', 'btnFabricReset',
      ];
      ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = disabled;
      });
    }

    function stopConnectionPolling() {
      if (connectionPollTimer) {
        clearInterval(connectionPollTimer);
        connectionPollTimer = null;
      }
    }

    function startConnectionPolling() {
      stopConnectionPolling();
      if (liveModeState !== 'live') return;
      connectionPollTimer = setInterval(() => {
        if (liveBusy) return;
        void refreshWorldSnapshot({ silent: true, soft: true }).catch(() => {
          /* ポーリング失敗はログを汚さない */
        });
      }, CONNECTION_POLL_MS);
    }

    /*
     * 停止中の Peer に、作り直しのたびに新しいブロックが付いて見えないようにする。
     * 画面はスナップショットごとに3台分を空にして作り直すので、空にする前に
     * 「停止中の Peer がいま何ブロック目まで持っているか」を控えておく。
     */
    let frozenPeerLimits = [Infinity, Infinity, Infinity];
    const PEER_NODE_NAMES = ['peer0.org1', 'peer1.org1', 'peer0.org2'];

    function isPeerDownInConnection(connection, idx) {
      const nodes = (connection && connection.nodes) || [];
      const node = nodes.find((n) => String(n.name || '').toLowerCase().replace(/\.example\.com$/, '') === PEER_NODE_NAMES[idx]);
      return Boolean(node && !node.ok);
    }

    function captureFrozenPeerLimits(snapshot) {
      frozenPeerLimits = peers.map((peer, idx) => {
        if (!isPeerDownInConnection(snapshot.connection, idx)) return Infinity;
        // すでに止めていた Peer は前回の上限を引き継ぐ。初めて止まったと分かった Peer は、いま表示している数で止める
        const prev = Number.isFinite(frozenPeerLimits[idx]) ? frozenPeerLimits[idx] : Infinity;
        const shown = Array.isArray(peer.blocks) && peer.blocks.length
          ? Math.max(...peer.blocks.map((b) => b.num)) + 1
          : Infinity;
        return Math.min(prev, shown);
      });
    }

    function resetPeerStateForHydrate() {
      peers.forEach((p) => {
        p.blocks = [];
        p.worldState = {};
        p.tampered = false;
        p.couchTampered = false;
        p.verifyDetected = false;
      });
    }

    function appendAuditLogToPeers(log) {
      const record = {
        logId: log.logId || `LOG-${log.targetId}`,
        eventType: log.eventType,
        targetId: log.targetId,
        userId: log.userId || 'admin@org1',
        orgId: log.orgId || 'Org1MSP',
        note: log.note || JSON.stringify({
          bf: log.audit?.bf || '',
          af: log.audit?.af || '',
          snap: log.audit?.snap || null,
        }),
        timestamp: log.timestamp || new Date().toISOString(),
        status: log.status || 'ACTIVE',
      };
      const txId = log.txId || `tx_${record.logId}`;

      peers.forEach((peer, idx) => {
        // 停止中の Peer には、止まった時点より後のブロックを足さない
        if (peer.blocks.length >= frozenPeerLimits[idx]) return;
        const prevBlock = peer.blocks[peer.blocks.length - 1];
        const prevHash = prevBlock ? prevBlock.hash : '0'.repeat(64);
        const tx = { txId, record };
        const block = {
          num: peer.blocks.length,
          prevHash,
          txs: [tx],
          isNew: false,
        };
        block.hash = blockHashOf(prevHash, block.txs);
        peer.blocks.push(block);

        peer.worldState[record.logId] = {
          kind: 'log',
          value: { ...record, _txId: txId, _block: block.num },
          updated: false,
        };

        if (log.eventType === 'ITEM_DELETE') {
          // 状態DB からは消える（履歴はブロックに残る）
          delete peer.worldState[`ITEM-${log.targetId}`];
        } else if (log.audit?.snap) {
          const itemKey = `ITEM-${log.targetId}`;
          peer.worldState[itemKey] = {
            kind: 'item',
            value: {
              id: log.targetId,
              quantity: Number(log.audit.snap.quantity || 0),
              version: Number(log.audit.snap.version || 1),
              af: log.audit.af || '',
            },
            updated: false,
          };
        }
      });
    }

    /**
     * Fabric の実ブロックをそのまま各ノードのレーンに並べる。
     * 番号・前のハッシュ・ハッシュは本物（サーバが QSCC で取得し、Fabric と同じ方法で計算）。
     * 状態DB（CouchDB）の表示は、ブロック内の監査ログから組み立てる。
     */
    function hydrateRealChain(chain) {
      realChainMeta = {
        height: chain.height,
        startBlock: chain.startBlock,
        hiddenCount: chain.hiddenCount,
        allLinksOk: chain.allLinksOk,
        allDataOk: chain.allDataOk,
        channel: chain.channel,
      };
      const heights = Array.isArray(chain.peerHeights) ? chain.peerHeights : [];
      const down = Array.isArray(chain.peerDown) ? chain.peerDown : [];
      peers.forEach((peer, idx) => {
        let limit = Number.isInteger(heights[idx]) ? heights[idx] : Infinity;
        // 止まっている Peer には新しいブロックを足さない（作り直す前に控えた数で止める）
        if (down[idx] || frozenPeerLimits[idx] !== Infinity) {
          limit = Math.min(limit, frozenPeerLimits[idx]);
        }
        peer.blocks = chain.blocks
          .filter((b) => b.num < limit)
          .map((b) => ({
            num: b.num,
            real: true,
            hash: b.hash,
            prevHash: b.prevHash,
            dataHash: b.dataHash,
            recomputedHash: b.recomputedHash,
            dataHashOk: b.dataHashOk,
            isNew: false,
            txs: b.txs.map((t) => ({
              txId: t.txId,
              txType: t.type,
              valid: t.valid,
              record: { ...(t.record || {}), txId: t.txId },
            })),
          }));
        peer.worldState = {};
        peer.blocks.forEach((block) => {
          block.txs.forEach((tx) => {
            const r = tx.record;
            if (!tx.valid || !r || !r.logId) return;
            peer.worldState[r.logId] = { kind: 'log', value: { ...r, _txId: tx.txId, _block: block.num }, updated: false };
            if (r.eventType === 'ITEM_DELETE') {
              delete peer.worldState[`ITEM-${r.targetId}`];
              return;
            }
            let note = null;
            try { note = JSON.parse(r.note || ''); } catch (_) { note = null; }
            if (note && note.snap && (r.eventType === 'ITEM_CREATE' || r.eventType === 'ITEM_UPDATE')) {
              peer.worldState[`ITEM-${r.targetId}`] = {
                kind: 'item',
                value: { id: r.targetId, quantity: Number(note.snap.quantity || 0), version: Number(note.snap.version || 1), af: note.af || '' },
                updated: false,
              };
            }
          });
        });
      });
      logCounter = 0;
    }

    function hydrateFromWorldSnapshot(snapshot) {
      if (!snapshot || !Array.isArray(snapshot.items)) {
        throw new Error('world-snapshot の形式が不正です');
      }

      liveMode = snapshot.source === 'live';
      mockFailureMode = !liveMode;
      liveModeState = liveMode ? 'live' : 'fallback';
      lastIntegrityReport = snapshot.integrity || null;
      lastWorldWarnings = Array.isArray(snapshot.warnings) ? snapshot.warnings : [];
      lastConnection = snapshot.connection || null;
      lastLocalHashCompares = Array.isArray(snapshot.localHashCompares) ? snapshot.localHashCompares : [];
      lastFetchedAt = snapshot.fetchedAt || null;
      lastItemCount = snapshot.items.length;
      lastAuditLogCount = Array.isArray(snapshot.auditLogs) ? snapshot.auditLogs.length : 0;
      lastTamperInfo = snapshot.tamperInfo || {
        pending: Boolean(snapshot.tamperPending),
        items: [],
      };

      const tamperById = new Map(
        (lastTamperInfo.items || []).map((row) => [row.itemId, row]),
      );
      const reportById = new Map(
        (snapshot.integrity?.itemReports || []).map((report) => [report.itemId, report]),
      );
      const hashCompareById = new Map(
        lastLocalHashCompares.map((row) => [row.itemId, row]),
      );

      masterItems = {};
      localHashStore = {};
      slaveDbItems = [{}, {}];
      slaveLocalHashStores = [{}, {}];
      verifyDetails = [];
      comparisonVerified = false;
      captureFrozenPeerLimits(snapshot);
      resetPeerStateForHydrate();

      snapshot.items.forEach((item) => {
        const report = reportById.get(item.id);
        const tamperRow = tamperById.get(item.id);
        const tampered = Boolean(
          tamperRow
          || (snapshot.tamperPending && report && !report.matches),
        );
        masterItems[item.id] = {
          id: item.id,
          name: item.name || item.id,
          category: item.category || '',
          quantity: Number(item.quantity || 0),
          location: item.location || '',
          status: item.status || 'ACTIVE',
          version: Number(item.version || 1),
          _tampered: tampered,
          _tamperedFromQty: tamperRow ? Number(tamperRow.beforeQuantity) : undefined,
          _updated: false,
          _verify: null,
        };

        const stored = snapshot.localHashes?.[item.id];
        const compare = hashCompareById.get(item.id);
        if (stored?.hash) {
          localHashStore[item.id] = {
            hash: stored.hash,
            snap: itemSnapshot(masterItems[item.id]),
            updatedAt: stored.updatedAt || '',
            _tampered: Boolean(
              tampered && compare && compare.matches && stored.source === 'attacker-aligned',
            ),
            _source: stored.source || '',
          };
        } else {
          syncLocalHashStore(masterItems[item.id]);
        }
        replicateToSlaves(item.id);
        // サーバ側のハッシュ保管庫はマスタ1台分（demo-local-hash.json）のみ存在する。
        // マシン2/3 の帳票B は UI 上のミラーとして複製する（シナリオ切替後も表示されるよう無条件で）
        replicateHashToSlaves(item.id);
      });

      if (snapshot.chain && Array.isArray(snapshot.chain.blocks)) {
        hydrateRealChain(snapshot.chain);
      } else {
        realChainMeta = null;
        const logs = (snapshot.auditLogs || []).slice().sort((a, b) =>
          String(a.timestamp || '').localeCompare(String(b.timestamp || '')),
        );
        logs.forEach((log) => appendAuditLogToPeers(log));
      }

      syncOpTargetSelect();
      startConnectionPolling();
      updateConnectionStatusBanner(); // 接続状態バナーを更新
      render();
    }

    async function refreshWorldSnapshot({ silent = false, soft = false } = {}) {
      let snapshot;
      try {
        snapshot = await fetchJson('/admin/api/demo/world-snapshot');
        if (snapshot?.source !== 'live' || !Array.isArray(snapshot.items)) {
          throw new Error('world-snapshot の形式が不正です');
        }
        lastSnapshotError = null;
      } catch (error) {
        lastSnapshotError = error.message || '状態を取得できませんでした';
        updateConnectionStatusBanner();
        throw error;
      }
      if (soft) {
        // ポーリング時は接続パネルだけ更新し、操作中のマップ状態を壊さない
        lastConnection = snapshot.connection || null;
        lastFetchedAt = snapshot.fetchedAt || lastFetchedAt;
        lastWorldWarnings = Array.isArray(snapshot.warnings) ? snapshot.warnings : lastWorldWarnings;
        lastLocalHashCompares = Array.isArray(snapshot.localHashCompares)
          ? snapshot.localHashCompares
          : lastLocalHashCompares;
        lastTamperInfo = snapshot.tamperInfo || lastTamperInfo;
        lastItemCount = Array.isArray(snapshot.items) ? snapshot.items.length : lastItemCount;
        lastAuditLogCount = Array.isArray(snapshot.auditLogs) ? snapshot.auditLogs.length : lastAuditLogCount;
        updateConnectionStatusBanner(); // ソフト更新時もバナーを更新
        return snapshot;
      }
      hydrateFromWorldSnapshot(snapshot);
      if (!silent) {
        const count = snapshot.items?.length || 0;
        const logCount = snapshot.auditLogs?.length || 0;
        const nodeText = snapshot.connection
          ? ` / ノード ${snapshot.connection.okCount}/${snapshot.connection.totalCount}`
          : '';
        pushLog(`実データを反映: 備品 ${count} 件 / 監査ログ ${logCount} 件${nodeText}`, 'ok');
        lastWorldWarnings.forEach((warning) => pushLog(warning, 'warn'));
      }
      return snapshot;
    }

    async function fetchDemoModeSetting() {
      try {
        const { mode } = await fetchJson('/admin/api/demo/mode');
        return ['auto', 'mock', 'live'].includes(mode) ? mode : 'auto';
      } catch {
        // モード取得自体に失敗した場合は従来通り auto（試行してダメならフォールバック）として扱う。
        return 'auto';
      }
    }

    async function bootstrapLiveData() {
      demoModeSetting = await fetchDemoModeSetting();
      mockFailureMode = false;

      if (demoModeSetting === 'mock') {
        // サーバがモック固定で起動している。実APIへは接続を試みずシミュレーションのみで動作する。
        liveMode = false;
        mockFailureMode = true;
        liveModeState = 'mock-forced';
        lastIntegrityReport = null;
        lastConnection = null;
        lastFetchedAt = null;
        stopConnectionPolling();
        updateConnectionStatusBanner(); // モック固定時もバナーを更新
        pushLog('起動時に DEMO_MODE=mock が指定されているため、シミュレーションのみで動作します（実際のブロックチェーンへは接続しません）。', 'warn');
        void loadNodeOpsPanel();
        return;
      }

      try {
        setLiveControlsDisabled(true);
        await refreshWorldSnapshot({ silent: true });
        pushLog('実 API から状態を読み込みました。操作は本物のマスタ・台帳に反映されます。', 'ok');
        if (lastConnection) {
          pushLog(
            `ノード接続: ${lastConnection.okCount}/${lastConnection.totalCount}`
              + (lastConnection.profileLabel ? `（${lastConnection.profileLabel}）` : ''),
            lastConnection.allOk ? 'ok' : 'warn',
          );
        }
        lastWorldWarnings.forEach((warning) => pushLog(warning, 'warn'));
        void loadNodeOpsPanel();
      } catch (error) {
        liveMode = false;
        lastIntegrityReport = null;
        lastConnection = null;
        stopConnectionPolling();

        if (demoModeSetting === 'live') {
          // 実通信指定なのでシミュレーションへは自動フォールバックせず、失敗を明示する。
          liveModeState = 'live-error';
          pushLog(`実 API 接続に失敗しました（DEMO_MODE=live のためフォールバックしません）: ${error.message}`, 'err');
        } else {
          liveModeState = 'fallback';
          mockFailureMode = true;
          pushLog(`実 API 接続に失敗: ${error.message}（シミュレーションモードで続行）`, 'warn');
        }
        updateConnectionStatusBanner(); // エラー時もバナーを更新
        void loadNodeOpsPanel();
      } finally {
        setLiveControlsDisabled(false);
      }
    }

    async function apiRegisterItem(item) {
      await fetchJson('/admin/api/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: item.id,
          name: item.name,
          category: item.category,
          quantity: item.quantity,
          location: item.location,
          status: item.status || 'ACTIVE',
        }),
      });
    }

    async function apiRegularUpdate(itemId, quantity) {
      const item = masterItems[itemId];
      if (!item) throw new Error('備品が見つかりません');
      await fetchJson('/admin/api/items', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: itemId,
          originalId: itemId,
          name: item.name,
          category: item.category,
          quantity,
          location: item.location,
          status: item.status || 'ACTIVE',
        }),
      });
    }

    async function apiDeleteItem(itemId) {
      if (!masterItems[itemId]) throw new Error('備品が見つかりません');
      await fetchJson('/admin/api/items', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: itemId }),
      });
    }

    async function apiTamperMaster(itemId, { alignLocalHash = false } = {}) {
      return fetchJson('/admin/api/demo/silent-master-tamper', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(itemId ? { itemId } : {}),
          alignLocalHash: Boolean(alignLocalHash),
        }),
      });
    }

    async function apiRevertTamper() {
      return fetchJson('/admin/api/demo/revert-master-tamper', { method: 'POST' });
    }

    async function apiIntegrity() {
      return fetchJson('/admin/api/integrity');
    }

    async function apiSeedDemo() {
      return fetchJson('/admin/api/demo/seed', { method: 'POST' });
    }

    // E2E自動化対応：ヘッドレス環境ではダイアログなしで実行
    function isHeadlessEnvironment() {
      // ヘッドレス Chrome/Puppeteer の検出
      return navigator.webdriver === true || 
             /HeadlessChrome/.test(navigator.userAgent) ||
             window.outerWidth === 0;
    }

    async function seedDemo() {
      // ヘッドレス環境では確認をスキップ
      const needConfirm = !isHeadlessEnvironment();
      
      if (needConfirm && !window.confirm('備品マスタを発表用の初期データ（PC-01 / CAM-01 / HDMI-01）に置き換えます。よろしいですか？')) {
        return;
      }
      try {
        setLiveControlsDisabled(true);
        const result = await apiSeedDemo();
        if (liveMode) {
          await refreshWorldSnapshot({ silent: true });
        } else {
          applySeedItemsLocal(result.items);
        }
        pushLog(`初期データを投入: ${result.count} 件`, 'ok');
        if (result.note) pushLog(result.note, 'warn');
      } catch (error) {
        pushLog(error.message || '初期データの投入に失敗しました', 'warn');
      } finally {
        setLiveControlsDisabled(false);
      }
    }

    // ── データの準備（ゼロに戻す / デモデータで埋める） ─────────

    function setDataPrepStatus(text, tone) {
      const el = document.getElementById('dataPrepStatus');
      if (!el) return;
      el.textContent = text;
      el.dataset.tone = tone || '';
    }

    function epochLabel(epoch) {
      if (!epoch) return '';
      return `LOG-${String(epoch.afterLogNumber).padStart(4, '0')}`;
    }

    async function refreshDataPrepStatus() {
      const group = document.getElementById('fabricResetGroup');
      try {
        const fr = await fetchJson('/admin/api/demo/fabric-reset');
        if (group) group.hidden = !(liveMode && fr.ready);
        if (fr.job && fr.job.state === 'running' && !fabricResetPolling) void pollFabricReset();
      } catch (_) {
        if (group) group.hidden = true;
      }
      const btn = document.getElementById('btnShowAllHistory');
      try {
        const status = await fetchJson('/admin/api/demo/data-status');
        if (btn) btn.hidden = !status.epoch;
        if (status.epoch && liveMode) {
          setDataPrepStatus(`リセット地点 ${epochLabel(status.epoch)} より後の台帳だけを表示中（それ以前の ${status.epoch.hiddenLogCount} 件はブロックとして残っています）。`, '');
        }
      } catch (_) {
        if (btn) btn.hidden = true;
      }
    }

    async function resetAllDemo() {
      const needConfirm = !isHeadlessEnvironment();
      const message = liveMode
        ? '備品マスタとローカルハッシュを空にし、台帳はこの時点から先だけを表示します。\n（ブロックチェーンのブロックは追記専用なので消えません）\nよろしいですか？'
        : '画面上のマスタ・ハッシュ・台帳をすべて空にします。よろしいですか？';
      if (needConfirm && !window.confirm(message)) return;
      try {
        setLiveControlsDisabled(true);
        if (liveMode) {
          const result = await fetchJson('/admin/api/demo/reset-all', { method: 'POST', timeoutMs: 30000 });
          await refreshWorldSnapshot({ silent: true });
          pushLog('ゼロに戻しました', 'ok');
          if (result.note) pushLog(result.note, '');
          setDataPrepStatus(result.note || 'ゼロに戻しました。', 'ok');
        } else {
          // mock: サーバ側のマスタファイルも空にしてから、画面の状態を消す
          await fetchJson('/admin/api/demo/reset-all', { method: 'POST' }).catch(() => null);
          reset();
          pushLog('ゼロに戻しました（シミュレーション）', 'ok');
          setDataPrepStatus('マスタ・ハッシュ・台帳を空にしました（シミュレーション）。', 'ok');
        }
      } catch (error) {
        pushLog(error.message || 'リセットに失敗しました', 'warn');
        setDataPrepStatus(error.message || 'リセットに失敗しました', 'warn');
      } finally {
        setLiveControlsDisabled(false);
        void refreshDataPrepStatus();
      }
    }

    async function fillDemoDataUi() {
      const rounds = Number(document.getElementById('fillRounds')?.value || 1);
      try {
        setLiveControlsDisabled(true);
        const plan = await fetchJson(`/admin/api/demo/fill-plan?rounds=${rounds}`);
        if (liveMode) {
          const seconds = Math.ceil(plan.steps.length * 2.5);
          setDataPrepStatus(`ブロックチェーンに ${plan.steps.length} 件を順番に書き込み中…（目安 ${seconds} 秒）`, '');
          pushLog(`デモデータを書き込み中: ${plan.steps.length} 件`, '');
          const result = await fetchJson('/admin/api/demo/fill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rounds }),
            timeoutMs: Math.max(60000, plan.steps.length * 10000),
          });
          await refreshWorldSnapshot({ silent: true });
          const msg = `${result.note}（${(result.elapsedMs / 1000).toFixed(1)} 秒）`;
          pushLog(msg, 'ok');
          if (result.skipped && result.skipped.length) {
            pushLog(`スキップ: ${result.skipped.map((s) => `${s.id}(${s.reason})`).join(', ')}`, 'warn');
          }
          setDataPrepStatus(msg, 'ok');
        } else {
          const result = fillDemoDataLocal(plan.steps);
          pushLog(`デモデータで埋めました（シミュレーション）: ${result.written} 件`, 'ok');
          setDataPrepStatus(`台帳に ${result.written} 件のブロックを追加しました（シミュレーション）。`, 'ok');
        }
      } catch (error) {
        // 途中で失敗しても、書けた分は台帳に残っているので画面を取り直す
        if (liveMode) await refreshWorldSnapshot({ silent: true }).catch(() => null);
        pushLog(error.message || 'デモデータの書き込みに失敗しました', 'warn');
        setDataPrepStatus(error.message || 'デモデータの書き込みに失敗しました', 'warn');
      } finally {
        setLiveControlsDisabled(false);
      }
    }

    let fabricResetPolling = false;

    async function pollFabricReset() {
      fabricResetPolling = true;
      setLiveControlsDisabled(true);
      let lastLen = 0;
      try {
        for (;;) {
          const fr = await fetchJson('/admin/api/demo/fabric-reset').catch(() => null);
          const job = fr && fr.job;
          if (job) {
            job.log.slice(lastLen).forEach((line) => pushLog(line, job.state === 'failed' ? 'warn' : ''));
            lastLen = job.log.length;
            if (job.state === 'running') {
              setDataPrepStatus(`ブロックチェーンを作り直し中… (${job.step}/${job.totalSteps}) ${job.stepLabel || ''}`, '');
            } else if (job.state === 'done') {
              setDataPrepStatus('ブロックチェーンをブロック0から作り直しました。台帳・マスタ・ハッシュは空です。', 'ok');
              break;
            } else {
              setDataPrepStatus(`ブロックチェーンの作り直しに失敗しました: ${job.error}`, 'warn');
              break;
            }
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
      } finally {
        fabricResetPolling = false;
        setLiveControlsDisabled(false);
        await refreshWorldSnapshot({ silent: true }).catch(() => null);
        void refreshDataPrepStatus();
      }
    }

    async function fabricResetUi() {
      if (!liveMode) return;
      const needConfirm = !isHeadlessEnvironment();
      if (needConfirm && !window.confirm('全VMの台帳データ（ブロック・CouchDB）を削除し、チャネルとチェーンコードを作り直します。\nこれまでのブロックは元に戻せません。数分かかります。\nよろしいですか？')) return;
      try {
        await fetchJson('/admin/api/demo/fabric-reset', { method: 'POST' });
        pushLog('ブロックチェーンの作り直しを開始しました', '');
        await pollFabricReset();
      } catch (error) {
        pushLog(error.message || 'ブロックチェーンの作り直しを開始できませんでした', 'warn');
        setDataPrepStatus(error.message || 'ブロックチェーンの作り直しを開始できませんでした', 'warn');
      }
    }

    async function showAllHistory() {
      try {
        setLiveControlsDisabled(true);
        const result = await fetchJson('/admin/api/demo/show-all-history', { method: 'POST' });
        if (liveMode) await refreshWorldSnapshot({ silent: true });
        pushLog(result.note, 'ok');
        setDataPrepStatus(result.note, 'ok');
      } catch (error) {
        pushLog(error.message || '全履歴の表示に失敗しました', 'warn');
      } finally {
        setLiveControlsDisabled(false);
        void refreshDataPrepStatus();
      }
    }

    function setNodeOpsResult(html, tone) {
      const el = document.getElementById('nodeOpsResult');
      if (!el) return;
      el.className = `node-ops-result${tone ? ` is-${tone}` : ''}`;
      el.innerHTML = html;
    }

    function renderMockNodeChips(statusEl) {
      if (!statusEl) return;
      statusEl.innerHTML = peers.map((peer, index) => `
        <span class="node-ops-chip ${getMockNodeStates()[index] ? 'is-up' : 'is-down'}">
          ${escapeHtml(peer.name)} ${getMockNodeStates()[index] ? '稼働' : '停止'}
        </span>
      `).join('');
    }

    async function refreshNodeOpsStatus() {
      const statusEl = document.getElementById('nodeOpsStatus');
      if (!statusEl) return;
      if (isMockFailureMode()) {
        renderMockNodeChips(statusEl);
        return;
      }
      try {
        const data = await fetchJson('/admin/api/node-status');
        // 取得中に Mock へ切り替わった場合は、実機の状態で上書きしない。
        if (isMockFailureMode()) {
          renderMockNodeChips(statusEl);
          return;
        }
        const nodes = data.nodes || [];
        // 台数はサーバー（VM）単位で数える。サーバー側がまとめていない古い応答ではノードをそのまま使う
        const servers = Array.isArray(data.servers) && data.servers.length ? data.servers : groupNodesByServer(nodes);
        const units = servers || nodes;
        if (!units.length) {
          statusEl.innerHTML = '<p class="ctrl-hint">ノード状態を取得できませんでした。</p>';
          return;
        }
        statusEl.innerHTML = units.map((unit) => `
          <span class="node-ops-chip ${unit.ok ? 'is-up' : 'is-down'}" title="${escapeHtml(describeServerMembers(unit))}">
            ${escapeHtml(unit.name || 'node')} ${unit.ok ? '稼働' : (unit.partial ? '一部停止' : '停止')}
          </span>
        `).join('');
        
        // ノード操作の直後にもバナーと各Peerの表示を更新する。
        lastConnection = {
          ...(lastConnection || {}),
          nodes,
          servers: servers || undefined,
          okCount: units.filter((n) => n.ok).length,
          totalCount: units.length,
          allOk: units.every((n) => n.ok),
        };
        updateConnectionStatusBanner();
      } catch {
        statusEl.innerHTML = '<p class="ctrl-hint">ノード状態を取得できませんでした。</p>';
      }
    }

    /** サーバー側がまとめていない応答でも、VM1〜3 にまとめて数える（Orderer と Peer を別に数えない） */
    function groupNodesByServer(nodes) {
      const layout = [
        { name: 'VM1', members: ['orderer', 'peer0.org1'] },
        { name: 'VM2', members: ['orderer2', 'peer1.org1'] },
        { name: 'VM3', members: ['orderer3', 'peer0.org2'] },
      ];
      const norm = (n) => String(n || '').toLowerCase().replace(/\.example\.com$/, '').replace(/^orderer1$/, 'orderer');
      const list = Array.isArray(nodes) ? nodes : [];
      const servers = layout.map((l) => {
        const members = list.filter((n) => l.members.includes(norm(n && n.name)));
        if (!members.length) return null;
        const ok = members.filter((m) => m.ok).length;
        return { name: l.name, ok: ok === members.length, partial: ok > 0 && ok < members.length, members: members.map((m) => ({ name: m.name, ok: Boolean(m.ok) })) };
      }).filter(Boolean);
      return servers.length ? servers : null;
    }

    /** サーバーに載っているノードごとの応答（例: orderer2 応答なし / peer1.org1 応答あり） */
    function describeServerMembers(unit) {
      if (!unit || !Array.isArray(unit.members)) return '';
      return unit.members.map((m) => `${m.name} ${m.ok ? '応答あり' : '応答なし'}`).join(' / ');
    }

    async function runNodeFailureAction(actionId, actionLabel = '') {
      if (!actionId) return;

      if (isMockFailureMode()) {
        const match = /^mock-vm(\d)-(stop|start)$/.exec(actionId);
        if (!match) {
          setNodeOpsResult('シミュレーション用のノード操作ではありません。', 'err');
          return;
        }
        const index = Number(match[1]) - 1;
        const up = match[2] === 'start';
        const result = setMockNodeState(index, up);
        if (!result.changed) {
          setNodeOpsResult(`${escapeHtml(peers[index]?.name || `VM${index + 1}`)} はすでに${up ? '稼働' : '停止'}しています。`, 'warn');
          return;
        }
        setNodeOpsResult(
          `<strong>${escapeHtml(peers[index].name)} を${up ? '復帰' : '停止'}しました。</strong>`
            + `<span>${up ? `停止中に追加された ${result.syncedBlocks} ブロックを同期しました。` : 'このノードには新しい記録が届きません。'}</span>`,
          up ? 'ok' : 'warn',
        );
        await refreshNodeOpsStatus();
        return;
      }

      // ヘッドレス環境では確認をスキップ
      const needConfirm = !isHeadlessEnvironment();
      if (needConfirm && !window.confirm(`${actionLabel || actionId} を実行します。\nよろしいですか？`)) return;
      try {
        setLiveControlsDisabled(true);
        const data = await fetchJson('/admin/api/demo/failure-scenario', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: actionId }),
        });
        setNodeOpsResult(`<strong>${escapeHtml(data.label || actionId)}</strong> を実行しました。<span>${escapeHtml(data.hint || '')}</span>`, 'warn');
        pushLog(data.label || actionId, 'warn');
        // 停止直後はすぐ、起動直後は時間がかかるので数回再確認する。
        void refreshNodeOpsStatus();
        [3000, 10000, 30000].forEach((delay) => {
          window.setTimeout(() => { void refreshNodeOpsStatus(); }, delay);
        });
      } catch (error) {
        setNodeOpsResult(escapeHtml(error.message || 'ノード操作に失敗しました'), 'err');
        pushLog(error.message || 'ノード操作に失敗しました', 'err');
      } finally {
        setLiveControlsDisabled(false);
      }
    }

    async function runNodeProbe(probe) {
      const resultEl = document.getElementById('nodeOpsResult');
      if (resultEl) resultEl.textContent = '確認中…';

      if (isMockFailureMode()) {
        const latencyMs = 20 + Math.floor(Math.random() * 70);
        const label = probe === 'write' ? '書き込み' : '読み取り';
        const ok = probe === 'write' ? canWriteMockLedger() : canReadMockLedger();
        const available = mockAvailableNodeCount();
        const message = probe === 'write'
          ? (ok
            ? `書き込みに成功しました（稼働 ${available}/3 台で合意）。`
            : `書き込みに失敗しました（稼働 ${available}/3 台。2台以上必要）。`)
          : (ok
            ? `読み取りに成功しました（稼働 ${available}/3 台）。`
            : '読み取りに失敗しました（全ノード停止）。');
        setNodeOpsResult(
          `<strong>${label}:</strong> ${escapeHtml(message)} <span>（${latencyMs} ms・シミュレーション）</span>`,
          ok ? 'ok' : 'err',
        );
        pushLog(`${label}確認: ${message}`, ok ? 'ok' : 'warn');
        announceChange(
          `${label}${ok ? '成功' : '失敗'} — 稼働 ${available}/3 台`,
          ok ? 'ok' : 'danger',
          3600,
        );
        return;
      }

      try {
        const data = await fetchJson('/admin/api/demo/fabric-probe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ probe }),
        });
        const label = probe === 'write' ? '書き込み' : '読み取り';
        setNodeOpsResult(
          `<strong>${label}:</strong> ${escapeHtml(data.message || (data.ok ? '成功' : '失敗'))}`
            + (data.latencyMs != null ? ` <span>（${data.latencyMs} ms）</span>` : ''),
          data.ok ? 'ok' : 'err',
        );
        pushLog(`${label}確認: ${data.message || (data.ok ? '成功' : '失敗')}`, data.ok ? 'ok' : 'warn');
      } catch (error) {
        setNodeOpsResult(escapeHtml(error.message || '確認に失敗しました'), 'err');
        pushLog(error.message || '確認に失敗しました', 'warn');
      }
    }

    async function loadNodeOpsPanel() {
      const availEl = document.getElementById('nodeOpsAvailability');
      const actionsEl = document.getElementById('nodeOpsActions');
      if (!availEl || !actionsEl) return;

      if (isMockFailureMode()) {
        availEl.innerHTML = '画面上のノード状態だけを変えます。例: VM2 を停止 → 正規更新 → VM2 に届かない → 復帰で差分同期。実機の Docker / Proxmox は操作しません。';
        actionsEl.innerHTML = peers.map((peer, index) => {
          const up = getMockNodeStates()[index];
          return `
            <button type="button" class="ctrl-btn ${up ? 'danger' : ''}" data-mock-node="${index}" data-mock-up="${up ? 0 : 1}">
              ${escapeHtml(peer.name)} を${up ? '停止' : '復帰'}
            </button>
          `;
        }).join('') + (getMockNodeStates().some((up) => !up)
          ? '<button type="button" class="ctrl-btn" data-mock-restore-all="1">全ノードを復帰</button>'
          : '');
        actionsEl.querySelectorAll('[data-mock-node]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const index = Number(btn.getAttribute('data-mock-node'));
            const up = btn.getAttribute('data-mock-up') === '1';
            void runNodeFailureAction(`mock-vm${index + 1}-${up ? 'start' : 'stop'}`);
          });
        });
        actionsEl.querySelector('[data-mock-restore-all]')?.addEventListener('click', async () => {
          for (let index = 0; index < peers.length; index += 1) {
            if (!getMockNodeStates()[index]) {
              await runNodeFailureAction(`mock-vm${index + 1}-start`);
            }
          }
        });
        await refreshNodeOpsStatus();
        return;
      }

      try {
        const data = await fetchJson('/admin/api/demo/failure-scenarios');
        if (!data.enabled) {
          availEl.textContent = '障害 API は無効です。DEMO_FAILURE_ENABLED=1 を設定すると、この画面からノードを停止・復帰できます。';
          actionsEl.innerHTML = '';
          return;
        }
        const backendLabel = data.backend === 'proxmox-qm' ? 'Proxmox qm' : 'Docker SSH';
        availEl.innerHTML = data.ready
          ? `サーバー（VM）を1台ずつ止める・動かす。方式: ${escapeHtml(backendLabel)} · 実行可能`
          : `方式: ${escapeHtml(backendLabel)} · ホスト設定が不足`;
        actionsEl.innerHTML = (data.actions || []).map((action) => `
          <button type="button" class="ctrl-btn ${String(action.id).includes('stop') ? 'danger' : ''}" data-failure-action="${escapeHtml(action.id)}" ${data.ready ? '' : 'disabled'}>
            ${escapeHtml(action.label)}
          </button>
        `).join('');
        actionsEl.querySelectorAll('[data-failure-action]').forEach((btn) => {
          btn.addEventListener('click', () => {
            void runNodeFailureAction(btn.getAttribute('data-failure-action'), btn.textContent.trim());
          });
        });
        await refreshNodeOpsStatus();
      } catch (error) {
        availEl.textContent = error.message || '障害設定の取得に失敗しました';
      }
    }

    function applyRealIntegrityReport(integrity, onlyItemId = null) {
      if (!integrity?.itemReports) return false;

      let ok = true;
      lastIntegrityReport = integrity;
      const reports = onlyItemId
        ? integrity.itemReports.filter((report) => report.itemId === onlyItemId)
        : integrity.itemReports;

      if (onlyItemId && reports.length === 0) {
        verifyDetails.push({
          title: `備品 ${onlyItemId}（実API）`,
          matches: false,
          reason: '台帳に照合できる監査記録がありません。',
          expectedLabel: '台帳',
          expected: '監査記録',
          currentLabel: '現在',
          current: 'なし',
        });
        return false;
      }

      reports.forEach((report) => {
        const item = masterItems[report.itemId];
        if (!item) return;

        const diffRows = (report.diffFields || []).map((row) => ({
          key: row.key,
          label: row.label,
          expectedValue: row.ledgerValue,
          currentValue: row.currentValue,
          differs: Boolean(row.changed),
        }));

        item._verify = {
          currentHash: report.currentHash,
          ledgerAf: report.ledgerHash,
          ledgerSnap: report.ledgerItem,
          currentSnap: report.currentItem,
          diffRows,
          matches: Boolean(report.matches),
        };

        if (!report.matches) {
          ok = false;
          verifyDetails.push({
            title: `備品 ${report.itemId}（実API）`,
            matches: false,
            reason: report.mismatchReason
              || 'マスタと台帳の内容ハッシュが一致しません（実データ照合）。',
            expectedLabel: '台帳af',
            expected: report.ledgerHash || '(無)',
            currentLabel: '現在hash',
            current: report.currentHash,
            rows: diffRows,
          });
        }
      });

      return ok;
    }

    function getLiveItemHash(item) {
      const report = lastIntegrityReport?.itemReports?.find((row) => row.itemId === item.id);
      return report?.currentHash || hashItem(item);
    }
    
    function getPeerConnectionStatus(index) {
      if (isMockFailureMode()) {
        return getMockNodeStates()[index]
          ? { text: '同期OK', down: false }
          : { text: '停止（応答なし）', down: true };
      }
      if (lastSnapshotError) return { text: '未確認', down: false };
      const peerName = ['peer0.org1', 'peer1.org1', 'peer0.org2'][index];
      const node = lastConnection?.nodes?.find((row) => {
        const name = String(row.name || '').toLowerCase();
        return name === peerName || name.startsWith(`${peerName}.`) || name === `peer${index}`;
      });
      if (!node) return { text: '未確認', down: false };
      return { text: node.ok ? '応答あり・同期未確認' : '応答なし', down: !node.ok };
    }

    // 接続状態バナーの更新
    function updateConnectionStatusBanner() {
      const banner = document.getElementById('connectionStatusBanner');
      const modeEl = document.getElementById('connectionMode');
      const nodesEl = document.getElementById('connectionNodes');
      const timeEl = document.getElementById('connectionLastUpdate');
      const indicatorsEl = document.getElementById('nodeIndicators');
      
      if (!banner || !modeEl || !nodesEl || !timeEl || !indicatorsEl) return;
      
      const stale = Boolean(lastSnapshotError) && liveModeState === 'live';
      banner.classList.toggle('is-stale', stale);
      const sourceEl = document.getElementById('displayProvenance');
      const healthEl = document.getElementById('connectionHealthNote');
      if (sourceEl) {
        sourceEl.textContent = liveModeState === 'live'
          ? '図の出所：取得した監査ログから再構成。ブロック番号・ハッシュは説明用で、各Peerの実ブロックや同期状況を直接示すものではありません。'
          : (liveModeState === 'mock-forced' || liveModeState === 'fallback')
            ? '図の出所：シミュレーション。実機の台帳・ノード状態を示すものではありません。'
            : '図の出所：実データ未取得。表示中の図は説明用の初期状態です。';
      }
      if (healthEl) {
        healthEl.textContent = stale
          ? `更新失敗：${lastSnapshotError}。前回取得時のデータを表示中です。接続状態・データ不一致は判定できません。`
          : liveModeState === 'live'
            ? 'ノード状態は接続確認の結果です。応答の回復だけでは履歴の同期完了を確認できません。'
            : liveModeState === 'mock-forced'
              ? 'ノードの停止・復帰は画面上のシミュレーションです。実機の停止・復帰ではありません。'
              : liveModeState === 'live-error' ? '接続できません。データ不一致を検出した結果ではありません。' : '';
      }
      const refreshBtn = document.getElementById('statusRefreshBtn');
      if (refreshBtn) refreshBtn.disabled = liveModeState === 'mock-forced';

      // モード表示
      let modeText = '確認中...';
      let modeClass = '';
      if (liveModeState === 'live') {
        modeText = stale ? 'Live（更新失敗・前回値）' : 'Live（実API）';
        modeClass = '';
      } else if (liveModeState === 'mock-forced') {
        modeText = 'Mock（シミュレーション）';
        modeClass = 'is-mock';
      } else if (liveModeState === 'fallback') {
        modeText = 'Mock（フォールバック）';
        modeClass = 'is-mock';
      } else if (liveModeState === 'live-error') {
        modeText = 'Live（接続エラー）';
        modeClass = '';
      }
      modeEl.textContent = modeText;
      modeEl.className = `status-value ${modeClass}`;
      
      // ノード状態表示
      if (stale) {
        nodesEl.textContent = '確認できません';
        indicatorsEl.innerHTML = '';
      } else if (liveModeState === 'mock-forced' || isMockFailureMode()) {
        const upCount = getMockNodeStates().filter(Boolean).length;
        nodesEl.textContent = `${upCount}/3 稼働（シミュレーション）`;
        indicatorsEl.innerHTML = '';
        getMockNodeStates().forEach((up, index) => {
          const indicator = document.createElement('div');
          indicator.className = `node-indicator ${up ? 'is-up' : 'is-down'}`;
          indicator.title = `VM${index + 1}: ${up ? '稼働' : '停止（シミュレーション）'}`;
          indicatorsEl.appendChild(indicator);
        });
      } else if (lastConnection?.nodes) {
        const units = Array.isArray(lastConnection.servers) && lastConnection.servers.length
          ? lastConnection.servers
          : (groupNodesByServer(lastConnection.nodes) || lastConnection.nodes);
        const totalCount = units.length;
        const okCount = units.filter((u) => u.ok).length;
        nodesEl.textContent = totalCount ? `${okCount}/${totalCount} 応答あり` : '未確認';
        
        // ノードインジケーター更新
        indicatorsEl.innerHTML = '';
        const currentNodeStates = new Map();
        

        units.forEach((node, index) => {
          const indicator = document.createElement('div');
          indicator.className = `node-indicator ${node.ok ? 'is-up' : 'is-down'}`;
          const members = describeServerMembers(node);
          indicator.title = `${node.name || `Node${index}`}: ${node.ok ? '応答あり' : (node.partial ? '一部応答なし' : '応答なし（停止・通信障害など）')}${members ? `（${members}）` : ''}`;
          indicatorsEl.appendChild(indicator);
          
          // 状態変化の検出
          const nodeKey = node.name || `node-${index}`;
          currentNodeStates.set(nodeKey, node.ok);
          
          if (connectionStatusInitialized && previousNodeStates.has(nodeKey)) {
            const prevState = previousNodeStates.get(nodeKey);
            if (prevState !== node.ok) {
              // 状態が変化した場合
              const stateText = node.ok ? '応答を再確認しました（履歴同期は未確認）' : '応答を確認できなくなりました';
              const logType = node.ok ? 'ok' : 'warn';
              pushLog(`ノード ${node.name || nodeKey} の${stateText}`, logType);
              
              // バナーにアニメーション効果を追加
              banner.classList.add('status-changed');
              setTimeout(() => banner.classList.remove('status-changed'), 800);
            }
          }
        });
        
        // 現在の状態を保存
        previousNodeStates = currentNodeStates;
      } else if (liveModeState === 'fallback') {
        nodesEl.textContent = '実機未接続';
        indicatorsEl.innerHTML = '';
      } else {
        nodesEl.textContent = '-/-';
        indicatorsEl.innerHTML = '';
      }
      
      if (liveModeState === 'live' || isMockFailureMode()) {
        peers.forEach((peer, idx) => {
          const statusEl = document.getElementById(`peerStatus${idx}`);
          if (!statusEl) return;
          const status = getPeerConnectionStatus(idx);
          statusEl.textContent = status.text;
          statusEl.classList.toggle('is-down', status.down);
          // 停止・復帰を検知したら、ページを再読み込みしなくてもレーンの「停止中」表示を切り替える
          const lane = document.getElementById(`peerLane${idx}`);
          if (lane && lane.classList) {
            lane.classList.toggle('is-down', status.down);
            let downNote = typeof lane.querySelector === 'function' ? lane.querySelector('.peer-down-note') : null;
            if (!downNote && status.down && typeof document.createElement === 'function') {
              downNote = document.createElement('div');
              downNote.className = 'peer-down-note';
              downNote.textContent = 'ノード停止中 — 新しい記録はこのノードに届きません';
              lane.appendChild(downNote);
            }
            if (downNote) downNote.hidden = !status.down;
          }
        });
      }

      // 最終更新時刻
      if (lastFetchedAt) {
        const updateTime = new Date(lastFetchedAt);
        const now = new Date();
        const diffMs = now - updateTime;
        
        let timeText;
        if (diffMs < 60000) { // 1分未満
          timeText = `${Math.floor(diffMs / 1000)}秒前`;
        } else if (diffMs < 3600000) { // 1時間未満
          timeText = `${Math.floor(diffMs / 60000)}分前`;
        } else {
          timeText = updateTime.toLocaleTimeString('ja-JP', { 
            hour: '2-digit', 
            minute: '2-digit' 
          });
        }
        timeEl.textContent = timeText;
      } else {
        timeEl.textContent = '-';
      }
      
      connectionStatusInitialized = true;
    }
    
    // 手動更新の実行
    async function manualRefreshConnection() {
      const refreshBtn = document.getElementById('statusRefreshBtn');
      if (!refreshBtn || demoModeSetting === 'mock') return;
      
      // ボタンを一時的に無効化
      refreshBtn.disabled = true;
      refreshBtn.style.opacity = '0.5';
      
      try {
        await refreshWorldSnapshot({ silent: false, soft: false });
        pushLog('接続状態を手動更新しました', 'ok');
      } catch (error) {
        pushLog(`手動更新に失敗: ${error.message}`, 'warn');
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.style.opacity = '1';
      }
    }
