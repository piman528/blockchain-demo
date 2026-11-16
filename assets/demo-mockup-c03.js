// ==========================================================================
// demo-mockup-c03.js
//   - C-03 (Fabric 台帳マップ) 固有のドメイン操作・描画:
//     - 3 Peer のチェーン伸長 (appendBlockToAllPeers)
//     - Peer / CouchDB の改ざん操作 (tamperPeer, tamperCouch)
//     - 中間ブロック改ざん「演出のみ」(simulateMidBlockTamper / clearMidBlockOverlay)
//     - 整合性検証 (verifyAll: チェーン再計算 / 多数決 / af 突合 / C-02 モード判定)
//     - レンダリング (renderPeers, couchHtml, blockHtml, renderSvgArrows)
//   - core.js の state / util に依存するため、core.js より後に読み込む。
// ==========================================================================

// ===== ブロック伸長 =====
function appendBlockToAllPeers(record, extraKVs = {}) {
  const txId = newTxId();
  const newBlocks = [];
  const skippedPeers = [];
  peers.forEach((peer) => {
    // 障害シナリオ中は停止ノードにブロックを届けない。復帰時に差分を同期する。
    if (activeScenario === 'c03' && !isMockNodeAvailable(peer.id)) {
      skippedPeers.push(peer.name);
      return;
    }
    const prevBlock = peer.blocks[peer.blocks.length - 1];
    const prevHash = prevBlock ? prevBlock.hash : '0'.repeat(64);
    // 各 Peer ごとに独立したトランザクションオブジェクトを作成
    const tx = { txId, record: { ...record } };
    const block = {
      num: peer.blocks.length,
      prevHash,
      txs: [tx],
      isNew: true,
    };
    block.hash = blockHashOf(prevHash, block.txs);
    peer.blocks.push(block);
    // CouchDB に PutState: LogRecord + (extra: itemKV)
    peer.worldState[record.logId] = {
      kind: 'log',
      value: { ...record, _txId: txId, _block: block.num },
      updated: true,
    };
    Object.entries(extraKVs).forEach(([k, v]) => {
      peer.worldState[k] = { kind: 'item', value: { ...v }, updated: true };
    });
    newBlocks.push({ peerId: peer.id, blockNum: block.num });
  });
  if (activeScenario === 'c03' && newBlocks.length) {
    announceChange(
      `ブロック #${newBlocks[0].blockNum} を追加 — 前のブロックと連結`
        + (skippedPeers.length ? `（${skippedPeers.join('・')} は停止中のため未反映）` : ''),
      'ok',
      4200,
    );
  }
  return { newBlocks, txId, logId: record.logId };
}

// ===== 改ざん操作（C-03 系） =====
function tamperCouch() {
  if (liveMode) {
    pushLog('注意: CouchDB 改ざんは画面上のシミュレーションのみです（実 Peer / 実 CouchDB は変更しません）', 'warn');
  }
  const peer = peers[2]; // VM3
  const itemId = document.getElementById('opTarget').value;
  const key = itemId ? `ITEM-${itemId}` : '';
  if (!key || !peer.worldState[key]) {
    const itemKeys = Object.keys(peer.worldState).filter((k) => k.startsWith('ITEM-'));
    if (!itemKeys.length) {
      pushLog('CouchDB に ITEM KV がありません。先に備品を登録してください', 'warn');
      return;
    }
    pushLog(`選択中の備品 ${itemId || '(未選択)'} に KV がありません`, 'warn');
    return;
  }
  const before = peer.worldState[key].value.quantity;
  peer.worldState[key].value = { ...peer.worldState[key].value, quantity: 777, _tampered: true };
  peer.worldState[key].updated = true;
  peer.couchTampered = true;
  pushLog(`${peer.name} の CouchDB[${key}].quantity ${before} → 777（チェーンは無傷）`, 'err');
  
  // 改ざんアラートを表示
  showTamperingAlert('silent');
  render(() => {
    spawnParticle('#btnTamperCouch', `[data-couch="${peer.id}"]`, 'danger');
  });
  scheduleAutoVerify(450);
}

function tamperPeer() {
  if (liveMode) {
    pushLog('注意: Peer 改ざんは画面上のシミュレーションのみです（実 Peer のブロックは変更しません）', 'warn');
  }
  const peer = peers[1]; // VM2
  if (!peer.blocks.length) {
    pushLog('改ざんできるブロックがありません', 'warn');
    return;
  }
  const block = peer.blocks[0];
  const tx = block.txs[0];
  try {
    const note = JSON.parse(tx.record.note);
    if (note.snap) note.snap.quantity = 666;
    note.af = hash('TAMPERED-AF');
    tx.record.note = JSON.stringify(note);
  } catch (_) {
    tx.record.note = '*** TAMPERED ***';
  }
  tx.record._tampered = true;
  peer.tampered = true;
  pushLog(`${peer.name} の Block#${block.num} を改ざん（hash は古いまま）`, 'err');
  
  // 改ざんアラートを表示
  showTamperingAlert('peer');
  render(() => {
    spawnParticle('#btnTamperPeer', `[data-block="${peer.id}-${block.num}"]`, 'danger');
  });
  scheduleAutoVerify(450);
}

// ===== 中間ブロック改ざん「演出のみ」=====
function simulateMidBlockTamper() {
  const peerSel = document.getElementById('midBlockPeer');
  const numSel = document.getElementById('midBlockNum');
  if (peerSel && !peerSel.value) peerSel.value = '1';
  if (numSel && !numSel.value) {
    updateMidBlockTamperPanel();
    if (numSel.options.length && numSel.options[0].value) {
      numSel.value = numSel.options[0].value;
    }
  }
  const peerId = Number(document.getElementById('midBlockPeer').value);
  const blockNum = Number(document.getElementById('midBlockNum').value);
  const peer = peers[peerId];
  if (!peer || !peer.blocks[blockNum]) {
    pushLog('中間ブロックが選択されていません', 'warn');
    return;
  }
  const fakeHash = hash('FAKE-' + Math.random()).slice(0, 8);
  demoOverlayState = { peerId, blockNum, fakeHash };
  pushLog(`演出: ${peer.name} ブロック#${blockNum} の値を ${fakeHash} に書き換え試行 → 次のブロックが持つ「前のハッシュ」とのつながりが崩れ、事実上改ざん不可`, 'warn');
  render(() => {
    spawnParticle('#btnTamperMidBlock', `[data-block="${peerId}-${blockNum}"]`, 'danger');
  });
  document.dispatchEvent(new CustomEvent('demo:midblock:simulated', {
    detail: { peerId, blockNum },
  }));
}

function clearMidBlockOverlay() {
  if (demoOverlayState.blockNum === null) return;
  demoOverlayState = { peerId: null, blockNum: null, fakeHash: null };
  pushLog('中間ブロック改ざん演出をリセット', '');
  render();
}

function ensureMidBlockForTutorial() {
  if (peers[0].blocks.length >= 3) {
    updateMidBlockTamperPanel();
    return;
  }
  while (peers[0].blocks.length < 3) {
    const seq = peers[0].blocks.length + 1;
    const dummyId = `DEMO-${seq}`;
    const record = {
      logId: newLogId(),
      eventType: 'ITEM_CREATE',
      targetId: dummyId,
      userId: 'admin@org1',
      orgId: 'Org1MSP',
      note: JSON.stringify({ af: hash(dummyId), snap: { id: dummyId, quantity: 1 } }),
      timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      status: 'ACTIVE',
    };
    appendBlockToAllPeers(record, {});
  }
  updateMidBlockTamperPanel();
  const numSel = document.getElementById('midBlockNum');
  if (numSel && numSel.options.length) numSel.value = numSel.options[0].value;
}

// ===== 整合性検証 =====
function clearPeerVerifyFlags() {
  peers.forEach((peer) => {
    peer.verifyDetected = false;
    peer.verifyMismatchBlocks = [];
    peer.blocks.forEach((b) => {
      b.verifyMismatch = false;
      b.minority = false;
    });
    Object.values(peer.worldState).forEach((entry) => {
      entry.verifyMismatch = false;
    });
  });
}

function verifyAllC01C02() {
  verifyDetails = [];
  comparisonVerified = true;
  Object.values(masterItems).forEach((item) => {
    item._verify = null;
  });
  clearPeerVerifyFlags();

  const liveTag = liveMode ? '（実データ）' : '';

  if (activeScenario === 'c01') {
    const items = Object.values(masterItems);
    if (!items.length) {
      pushLog('照合対象の備品がありません', 'warn');
    } else {
      items.forEach((item) => {
        const qtyNote = item._tampered && typeof item._tamperedFromQty === 'number'
          ? `${item.quantity}（元: ${item._tamperedFromQty}）`
          : String(item.quantity);
        verifyDetails.push({
          headline: `検知不可: 備品 ${item.id}${liveTag}`,
          matches: false,
          reason: item._tampered
            ? `マスタとスレーブ2台はすべて qty=${qtyNote} で揃っています。正しい値を参照する照合基準がないため、改ざんを検知できません。`
            : '3台のDBは同じ内容です。改ざん後に照合しても、どれが正しいか判断する基準はありません。',
          expectedLabel: 'マスタ qty',
          expected: item.quantity,
          currentLabel: 'スレーブ qty',
          current: slaveDbItems[0][item.id]?.quantity ?? '(無)',
        });
      });
      pushLog(`照合完了${liveTag}: マスタとスレーブは同じ値ですが、正しい値を判定する基準がありません`, 'warn');
    }
    render();
    document.dispatchEvent(new CustomEvent('demo:verify:completed', {
      detail: { ok: true, scenario: 'c01', verifyDetails },
    }));
    return;
  }

  const items = Object.values(masterItems);
  if (!items.length) {
    pushLog('照合対象の備品がありません', 'warn');
    render();
    document.dispatchEvent(new CustomEvent('demo:verify:completed', {
      detail: { ok: true, scenario: 'c02', verifyDetails: [] },
    }));
    return;
  }

  const compareById = new Map(
    (typeof lastLocalHashCompares !== 'undefined' ? lastLocalHashCompares : [])
      .map((row) => [row.itemId, row]),
  );

  items.forEach((item) => {
    const local = localHashStore[item.id];
    if (!local) return;
    const serverCompare = liveMode ? compareById.get(item.id) : null;
    const currentHash = serverCompare?.currentHash || hashItem(item);
    const storedHash = serverCompare?.storedHash || local.hash;
    const localMatches = serverCompare
      ? Boolean(serverCompare.matches)
      : (storedHash === currentHash);
    if (c02TamperMode === 'A' && !localMatches) {
      verifyDetails.push({
        title: `C-02: 備品 ${item.id}${liveTag}`,
        matches: false,
        reason: liveMode
          ? '実ファイル demo-local-hash.json の保存hash と、items.json から再計算した current が不一致です。'
          : '保存hash（帳票B）と current（帳票A から再計算）が食い違っています → DBのみ改ざんを検知できます。',
        expectedLabel: '保存hash',
        expected: storedHash,
        currentLabel: 'current hash',
        current: currentHash,
      });
    } else if (c02TamperMode === 'B' && item._tampered && localMatches) {
      verifyDetails.push({
        headline: `検知不可: 備品 ${item.id}${liveTag}`,
        matches: false,
        reason: '保存hash も current に合わせられているため、帳票A+B だけでは検知できません。C-03 では台帳側ハッシュは書き換えられないため、この攻撃は成立しません。',
        expectedLabel: '保存hash',
        expected: storedHash,
        currentLabel: 'current hash',
        current: currentHash,
      });
    } else if (localMatches) {
      verifyDetails.push({
        title: `C-02: 備品 ${item.id}${liveTag}`,
        matches: true,
        reason: '保存hash と current が一致しています。',
        expectedLabel: '保存hash',
        expected: storedHash,
        currentLabel: 'current hash',
        current: currentHash,
      });
    } else {
      verifyDetails.push({
        title: `C-02: 備品 ${item.id}${liveTag}`,
        matches: false,
        reason: '保存hash ≠ current hash → DBのみ改ざんを検知できます。',
        expectedLabel: '保存hash',
        expected: storedHash,
        currentLabel: 'current hash',
        current: currentHash,
      });
    }
  });

  const item = typeof getComparisonTargetItem === 'function' ? getComparisonTargetItem() : items[0];
  if (item) {
    const local = localHashStore[item.id];
    const serverCompare = liveMode ? compareById.get(item.id) : null;
    const currentHash = serverCompare?.currentHash || hashItem(item);
    const localMatches = serverCompare
      ? Boolean(serverCompare.matches)
      : Boolean(local && local.hash === currentHash);
    if (c02TamperMode === 'A' && local && !localMatches) {
      pushLog(`${item.id}${liveTag}: 保存hash ≠ current → DBのみ改ざんを検知`, 'warn');
    } else if (c02TamperMode === 'B' && item._tampered && localMatches) {
      pushLog(`${item.id}${liveTag}: 保存hash も揃ったためローカルでは検知不可`, 'warn');
    } else if (localMatches) {
      pushLog(`照合OK${liveTag}: 保存hash と current は一致`, 'ok');
    } else {
      pushLog(`照合完了${liveTag}`, 'ok');
    }
  }

  render();
  document.dispatchEvent(new CustomEvent('demo:verify:completed', {
    detail: { ok: true, scenario: 'c02', verifyDetails },
  }));
}

async function verifyAll() {
  if (activeScenario === 'c01' || activeScenario === 'c02') {
    verifyAllC01C02();
    return;
  }

  let ok = true;
  const issues = [];
  verifyDetails = [];
  comparisonVerified = true;

  clearPeerVerifyFlags();

  const available = peers
    .map((peer, index) => ({ peer, index }))
    .filter(({ index }) => isMockNodeAvailable(index));
  const unavailableNames = peers
    .filter((_, index) => !isMockNodeAvailable(index))
    .map((peer) => peer.name);

  if (!available.length) {
    comparisonVerified = false;
    Object.values(masterItems).forEach((item) => { item._verify = null; });
    verifyDetails.push({
      title: '照合できません',
      matches: false,
      reason: '全ノードが停止しているため、台帳の値を取得できません。これは「不一致」ではなく「照合不能」です。',
      expectedLabel: '必要な状態',
      expected: '1台以上の稼働ノード',
      currentLabel: '現在',
      current: '全台停止',
    });
    pushLog('✗ 照合できません: 全ノード停止中（不一致ではありません）', 'warn');
    announceChange('照合できません — 全ノードが停止しています（不一致ではありません）', 'danger', 5200);
    render();
    document.dispatchEvent(new CustomEvent('demo:verify:completed', {
      detail: { ok: false, unavailable: true, scenario: activeScenario, verifyDetails },
    }));
    return;
  }

  // 1. 各 Peer のチェーン整合性（停止中のノードは対象外）
  available.forEach(({ peer }) => {
    peer.verifyMismatchBlocks = [];
    for (let i = 0; i < peer.blocks.length; i++) {
      const b = peer.blocks[i];
      const recomputed = recomputeBlockHash(b);
      b.verifyMismatch = recomputed !== b.hash;
      if (b.verifyMismatch) {
        peer.verifyMismatchBlocks.push(i);
        peer.verifyDetected = true;
        ok = false;
        issues.push(`${peer.name} ブロック#${b.num}: 検算結果が一致しません`);
        verifyDetails.push({
          title: `${peer.name} ブロック#${b.num}`,
          matches: false,
          reason: '保存されている「ハッシュ」と、いまの内容から検算した結果が一致しません。',
          expectedLabel: '保存されている値',
          expected: b.hash,
          currentLabel: '検算結果',
          current: recomputed,
        });
      }
    }
  });

  // 2. Peer 間 多数決（停止中のノードは対象外）
  const blockCount = Math.max(...available.map(({ peer }) => peer.blocks.length));
  for (let n = 0; n < blockCount; n++) {
    const hashes = available.map(({ peer }) => peer.blocks[n]?.hash).filter(Boolean);
    const counts = {};
    hashes.forEach((h) => { counts[h] = (counts[h] || 0) + 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 1) {
      ok = false;
      const majority = sorted[0][0];
      available.forEach(({ peer: p }) => {
        if (p.blocks[n] && p.blocks[n].hash !== majority) {
          p.blocks[n].minority = true;
          p.verifyDetected = true;
          issues.push(`${p.name} Block#${n}: 多数決から外れた（少数派）`);
          verifyDetails.push({
            title: `${p.name} Block#${n}`,
            matches: false,
            reason: '3台の同じ番号のブロックを比べた結果、この台だけ多数派の値と異なります。',
            expectedLabel: '多数派の値',
            expected: majority,
            currentLabel: 'この台の値',
            current: p.blocks[n].hash,
          });
        }
      });
    }
  }

  // 2.5 各 Peer の CouchDB と Block 内の af の突合（同一 Peer 内・停止中は対象外）
  available.forEach(({ peer }) => {
    Object.entries(peer.worldState).forEach(([k, entry]) => {
      if (entry.kind !== 'item') return;
      // 同じ targetId の最新 Block af
      const itemId = k.replace(/^ITEM-/, '');
      const chainAf = findLatestLedgerAf(peer, itemId);
      if (chainAf && entry.value.af && chainAf !== entry.value.af) {
        ok = false;
        issues.push(`${peer.name} CouchDB[${k}].af ≠ チェーン af`);
        peer.verifyDetected = true;
        entry.verifyMismatch = true;
        verifyDetails.push({
          title: `${peer.name} CouchDB[${k}]`,
          matches: false,
          reason: '状態DBに保存された備品の値と、同じ台のチェーンに残る最新の監査用の値が一致しません。',
          expectedLabel: 'チェーンの監査用の値',
          expected: chainAf,
          currentLabel: '状態DBの監査用の値',
          current: entry.value.af,
        });
      }
    });
  });

  // 3. マスタ vs 台帳の af（実APIでは本物の整合性レポートを使用）
  if (liveMode) {
    try {
      setLiveControlsDisabled(true);
      const integrity = await apiIntegrity();
      // 実APIでは、操作パネルで選択中の備品だけを照合する。
      // （過去の検証で残った別備品の不一致で、デモ全体が赤くならないようにする）
      const selectedId = document.getElementById('opTarget')?.value || '';
      const integrityOk = applyRealIntegrityReport(integrity, selectedId || null);
      if (!integrityOk) {
        ok = false;
        const reports = selectedId
          ? integrity.itemReports.filter((report) => report.itemId === selectedId)
          : integrity.itemReports;
        reports
          .filter((report) => !report.matches)
          .forEach((report) => issues.push(`${report.itemId}: マスタ vs 台帳 af 不一致（実API）`));
      }
      if (selectedId) {
        pushLog(`実API照合: 選択中の備品 ${selectedId} のみ`, '');
      }
    } catch (error) {
      ok = false;
      issues.push(`実API照合失敗: ${error.message}`);
      verifyDetails.push({
        title: '実API照合',
        matches: false,
        reason: error.message || '整合性APIの取得に失敗しました',
        expectedLabel: '期待',
        expected: '台帳の監査用の値',
        currentLabel: '現在',
        current: '取得失敗',
      });
    } finally {
      setLiveControlsDisabled(false);
    }
  } else {
    // 停止中の VM1 に固定せず、稼働中の代表ノードと照合する。
    const ledgerPeer = available[0].peer;
    Object.values(masterItems).forEach((item) => {
      const currentHash = hashItem(item);
      const currentSnap = itemSnapshot(item);
      const ledgerAf = findLatestLedgerAf(ledgerPeer, item.id);
      const ledgerSnap = findLatestLedgerSnapshot(ledgerPeer, item.id);
      const diffRows = buildSnapshotDiffRows(ledgerSnap, currentSnap);
      item._verify = { currentHash, ledgerAf, ledgerSnap, currentSnap, diffRows, matches: ledgerAf === currentHash };
      if (!item._verify.matches) {
        ok = false;
        issues.push(`${item.id}: マスタと台帳の監査用の値が不一致`);
        verifyDetails.push({
          title: `備品 ${item.id}`,
          matches: false,
          reason: 'いまのマスタ値から計算した値と、台帳に記録された監査用の値が一致しません。正規の更新を通さずにマスタだけが書き換えられた可能性があります。',
          expectedLabel: '台帳の監査用の値',
          expected: ledgerAf || '(無)',
          currentLabel: 'いまの値',
          current: currentHash,
          rows: diffRows,
        });
      }
    });
  }

  if (unavailableNames.length) {
    pushLog(`停止中のノードは照合対象外: ${unavailableNames.join('・')}`, 'warn');
  }

  const spotlightEl = document.getElementById('changeSpotlight');
  const hasActiveSpotlight = Boolean(spotlightEl && !spotlightEl.hidden);

  if (ok) {
    verifyDetails.push({
      title: '検証OK',
      matches: true,
      reason: liveMode
        ? '実API照合でマスタと台帳の監査用の値が一致しています。'
        : 'マスタのいまの値、状態DB、各台のブロックの値が照合基準と一致しています。'
          + (unavailableNames.length ? `（${unavailableNames.join('・')} は停止中のため対象外）` : ''),
      expectedLabel: '期待',
      expected: liveMode ? '台帳の監査用の値（実API）' : '台帳・多数派・状態DB',
      currentLabel: '現在',
      current: '一致',
    });
    if (!hasActiveSpotlight) {
      announceChange(
        `照合OK — マスタと台帳が一致${unavailableNames.length ? `（${unavailableNames.join('・')} は停止中）` : ''}`,
        'ok',
        4200,
      );
    }
  } else {
    announceChange('不一致を検知 — マスタと台帳の値が異なります', 'danger', 4600);
  }

  pushLog(
    ok
      ? `✓ 検証OK: ${liveMode ? '実API照合' : '全台同期 + マスタ整合'}`
      : '✗ 検証NG: ' + issues.slice(0, 3).join(' / '),
    ok ? 'ok' : 'err',
  );
  render();
  document.dispatchEvent(new CustomEvent('demo:verify:completed', {
    detail: { ok, scenario: activeScenario, verifyDetails },
  }));
}

// ===== レンダリング (Peer/Block/CouchDB) =====
// 3方式比較では Fabric のレーンが長くなりすぎないよう、最新のブロックだけを既定で表示する
const COMPARE_RECENT_BLOCKS = 8;
let compareShowAllBlocks = false;

function renderPeers() {
  peers.forEach((peer, i) => {
    const rail = document.getElementById('peerRail' + i);
    const label = document.getElementById('peerLabel' + i);
    const lane = document.getElementById('peerLane' + i);

    const anyAttack = peer.tampered || peer.couchTampered;
    const anyDetected = peer.verifyDetected || peer.blocks.some((b) => b.verifyMismatch || b.minority);
    label.classList.toggle('is-tampered', anyAttack);
    label.classList.toggle('is-detected', !anyAttack && anyDetected);
    const statusEl = document.getElementById('peerStatus' + i);
    const connectionStatus = (liveMode || mockFailureMode) ? getPeerConnectionStatus(i) : null;
    const isDown = Boolean(connectionStatus?.down);
    statusEl.classList.toggle('is-down', isDown);
    statusEl.textContent = isDown ? connectionStatus.text :
      peer.tampered ? 'チェーン改ざん' :
        peer.couchTampered ? '状態DB改ざん' :
          anyDetected ? '不一致検知' : '同期OK';

    if (lane) {
      lane.classList.toggle('is-down', isDown);
      let downNote = lane.querySelector('.peer-down-note');
      if (!downNote) {
        downNote = document.createElement('div');
        downNote.className = 'peer-down-note';
        lane.appendChild(downNote);
      }
      downNote.hidden = !isDown;
      downNote.textContent = 'ノード停止中 — 新しい記録はこのノードに届きません';
    }

    const meta = typeof realChainMeta !== 'undefined' ? realChainMeta : null;
    const parts = [];
    if (meta && meta.hiddenCount > 0) {
      // 実ブロック：リセット地点より前は省略（ブロック自体は台帳に残っている）
      parts.push(`<div class="block is-genesis is-omitted"><div class="gnum">#0〜#${meta.hiddenCount - 1}</div><div style="font-size:0.85rem;color:#64748b;">${meta.hiddenCount}個のブロックを省略<br>（ゼロに戻す前の記録）</div></div>`);
    } else if (!(peer.blocks[0] && peer.blocks[0].real)) {
      // 説明用の表示では起点を描く（実ブロックでは #0 の設定ブロックが本物の起点）
      parts.push('<div class="block is-genesis"><div class="gnum">起点</div><div style="font-size:0.85rem;color:#64748b;">前のハッシュ = （なし）</div></div>');
    }
    const inCompare = typeof isAllMethodsView === 'function' && isAllMethodsView();
    const canCollapse = inCompare && peer.blocks.length > COMPARE_RECENT_BLOCKS;
    const collapsed = canCollapse && !compareShowAllBlocks;
    const shownBlocks = collapsed ? peer.blocks.slice(-COMPARE_RECENT_BLOCKS) : peer.blocks;
    if (collapsed) {
      const first = peer.blocks[0].num;
      const last = shownBlocks[0].num - 1;
      const count = peer.blocks.length - shownBlocks.length;
      parts.push(`<button type="button" class="block is-genesis block-collapse-toggle" data-blocks-toggle="expand" title="省略したブロックも表示する">
        <span class="gnum">#${first}〜#${last}</span>
        <span class="block-collapse-text">${count}個</span>
        <span class="block-collapse-action">表示 ▸</span>
      </button>`);
    } else if (canCollapse) {
      parts.push(`<button type="button" class="block is-genesis block-collapse-toggle is-expanded" data-blocks-toggle="collapse" title="最新${COMPARE_RECENT_BLOCKS}ブロックだけの表示に戻す">
        <span class="gnum">全${peer.blocks.length}個</span>
        <span class="block-collapse-action">◂ 最新${COMPARE_RECENT_BLOCKS}個</span>
      </button>`);
    }
    if (!peer.blocks.length) {
      parts.push('<div style="color:#64748b;font-size:0.9rem;padding:20px;">ブロック待機中</div>');
    } else {
      shownBlocks.forEach((b) => parts.push(blockHtml(b, peer)));
    }
    parts.push(couchHtml(peer));
    rail.innerHTML = parts.join('');
  });
}

function couchHtml(peer) {
  const logKeys = Object.keys(peer.worldState).filter((k) => k.startsWith('LOG-'));
  const itemKeys = Object.keys(peer.worldState).filter((k) => k.startsWith('ITEM-'));
  const total = logKeys.length + itemKeys.length;

  const renderRows = (keys, cls) => {
    if (!keys.length) return '<div style="font-size:0.85rem;color:#64748b;">（空）</div>';
    return keys.map((k) => {
      const entry = peer.worldState[k];
      const v = entry.value;
      const updated = entry.updated;
      const tampered = v._tampered;
      const detected = entry.verifyMismatch;
      let body = '';
      if (entry.kind === 'item') {
        body = `<span title="備品の個数">個数</span>=<span class="${tampered ? 'bad' : ''}">${v.quantity}</span> <span title="マスタが何回更新されたか">版数</span>=${v.version}<br><span title="備品データの正しさを残すための値">監査用の値</span>=${hashHtml(v.af)}`;
      } else {
        body = `${v.eventType} ${v.targetId}<br>取引番号=${hashHtml(v._txId)}`;
      }
      return `
            <div class="kv-row ${cls} ${updated ? 'is-updated' : ''} ${tampered ? 'is-tampered' : ''} ${detected ? 'is-detected' : ''}">
              <div class="kv-key">${k}</div>
              <div class="kv-val">${body}</div>
            </div>
          `;
    }).join('');
  };

  return `
        <div class="couchdb ${peer.couchTampered ? 'is-tampered' : ''} ${Object.values(peer.worldState).some((entry) => entry.verifyMismatch) ? 'is-detected' : ''}" data-couch="${peer.id}">
          <div class="couchdb-head">
            <span class="icon">状態</span>
            状態DB
            <span class="stat">${total}件</span>
          </div>
          <div class="couchdb-body">
            <div class="kv-section-label">監査ログ</div>
            ${renderRows(logKeys, '')}
            <div class="kv-section-label">備品データ</div>
            ${renderRows(itemKeys, 'is-item')}
          </div>
        </div>
      `;
}

const TX_EVENT_LABELS = {
  CONFIG: 'チャネル設定',
  CHAINCODE_DEPLOY: 'チェーンコード配備',
  NOTE: '書き込み確認',
};
function txEventLabel(tx) {
  const t = tx.record.eventType || '';
  return TX_EVENT_LABELS[t] ? `${TX_EVENT_LABELS[t]}` : escapeHtml(t);
}

function blockHtml(b, peer) {
  const isOverlayed = demoOverlayState.peerId === peer.id && demoOverlayState.blockNum === b.num;
  const isNextOfOverlay = demoOverlayState.peerId === peer.id
    && demoOverlayState.blockNum === b.num - 1
    && demoOverlayState.fakeHash;
  const fakeHash = demoOverlayState.fakeHash;
  const cls = [
    'block',
    b.isNew ? 'is-new' : '',
    (b.verifyMismatch || b.minority) ? 'is-detected' : '',
    isOverlayed ? 'is-mid-tampered' : '',
    isNextOfOverlay ? 'is-chain-stale' : '',
  ].filter(Boolean).join(' ');
  const recomputed = recomputeBlockHash(b);
  const hashClass = (b.verifyMismatch || b.minority) ? 'mismatch' : '';
  const prevLineHtml = isNextOfOverlay ? `
          <div class="hash-line is-chain-broken" data-tutorial-target="mid-block-next-prev">
            <span class="label" title="ひとつ前のブロックのハッシュ（つながりの確認用）">前のハッシュ</span>
            <span class="val hash-prev-stale">${hashHtml(b.prevHash)}</span>
          </div>
        ` : `
          <div class="hash-line">
            <span class="label" title="ひとつ前のブロックのハッシュ（つながりの確認用）">前のハッシュ</span><span class="val">${hashHtml(b.prevHash)}</span>
          </div>
        `;
  const hashLineHtml = isOverlayed && fakeHash ? `
          <div class="hash-line is-attack" data-tutorial-target="mid-block-hash-attack">
            <span class="label" title="このブロック全体から計算したハッシュ">ハッシュ</span>
            <span class="val hash-attack-cell">
              <span class="hash-val-was" title="元の値（取引内容から検算するとこうなる）">${hashHtml(b.hash)}</span>
              <span class="hash-attack-arrow" aria-hidden="true">→</span>
              <span class="hash-val-fake" title="攻撃者がここだけ書き換え試行">${hashHtml(fakeHash)}</span>
            </span>
          </div>
        ` : `
          <div class="hash-line">
            <span class="label" title="このブロック全体から計算したハッシュ">ハッシュ</span><span class="val ${hashClass}">${hashHtml(b.hash)}</span>
          </div>
        `;
  const txs = b.txs.map((tx) => {
    const tampered = tx.record._tampered;
    let extra = '';
    try {
      const note = JSON.parse(tx.record.note);
      if (note && note.snap) extra = `<div class="tx-row"><span class="k" title="備品の個数">個数</span><span class="v ${tampered ? 'bad' : ''}">${note.snap.quantity}</span></div>`;
      if (note && note.af) extra += `<div class="tx-row" data-tutorial-target="block-af-row"><span class="k" title="備品データの正しさを残すための値">監査用の値</span><span class="v ${tampered ? 'bad' : ''}">${hashHtml(note.af)}</span></div>`;
    } catch (_) { }
    return `
          <div class="tx ${tampered ? 'is-tampered' : ''}">
            <div class="tx-id" title="この操作を識別する番号">取引 ${hashHtml(tx.txId)}</div>
            <div class="tx-row"><span class="k" title="操作の種類">操作</span><span class="v">${txEventLabel(tx)}</span></div>
            ${tx.record.targetId ? `<div class="tx-row"><span class="k" title="対象">対象</span><span class="v">${escapeHtml(tx.record.targetId)}</span></div>` : ''}
            ${tx.valid === false ? '<div class="tx-row"><span class="k">検証</span><span class="v bad">無効な取引（台帳には残るが反映されない）</span></div>' : ''}
            ${extra}
          </div>
        `;
  }).join('');
  return `
        <div class="${cls}" data-block="${peer.id}-${b.num}">
          <div class="block-head"><span class="block-num">ブロック #${b.num}</span><span class="block-tx-count">${b.txs.length}件</span></div>
          ${prevLineHtml}
          ${hashLineHtml}
          ${b.verifyMismatch ? `<div class="hash-line"><span class="label" title="いまの内容からもう一度計算した値">検算結果</span><span class="val mismatch">${hashHtml(recomputed)}</span></div>` : ''}
          <div class="block-divider"></div>
          ${txs}
        </div>
      `;
}

function renderSvgArrows() {
  const svg = document.getElementById('svgArrows');
  const parts = [];

  // 各 Peer のブロック間チェーン矢印
  peers.forEach((peer, i) => {
    const railEl = document.getElementById('peerRail' + i);
    const blocks = Array.from(railEl.querySelectorAll('.block'));
    const railRect = mapWorld.getBoundingClientRect();
    for (let k = 0; k < blocks.length - 1; k++) {
      const a = blocks[k].getBoundingClientRect();
      const b = blocks[k + 1].getBoundingClientRect();
      // map-world 座標に戻す（scale/translate を逆算）
      const x1 = (a.right - railRect.left) / view.scale;
      const y1 = (a.top + a.height / 2 - railRect.top) / view.scale;
      const x2 = (b.left - railRect.left) / view.scale;
      const y2 = (b.top + b.height / 2 - railRect.top) / view.scale;
      const midChainBreak = demoOverlayState.peerId === i
        && demoOverlayState.fakeHash
        && k === demoOverlayState.blockNum + 1;
      const bad = (peer.blocks[k] && peer.blocks[k].minority) || midChainBreak;
      const isNewLink = Boolean(peer.blocks[k]?.isNew) || blocks[k + 1].classList.contains('is-new');
      parts.push(`<path class="${isNewLink ? 'is-new-link' : ''}" d="M${x1} ${y1} C ${x1 + 20} ${y1}, ${x2 - 20} ${y2}, ${x2} ${y2}"
            stroke="${bad ? '#ef4444' : '#94a3b8'}" stroke-width="2" fill="none"
            marker-end="url(#${bad ? 'arrowHeadBad' : 'arrowHead'})"
            stroke-dasharray="${bad ? '5,4' : '0'}"/>`);
    }
  });

  // Peer 間 同期線（同じ Block 番号を縦に薄く繋ぐ）
  const maxN = Math.max(...peers.map((p) => p.blocks.length));
  for (let n = 0; n < maxN; n++) {
    const targets = [];
    peers.forEach((p, i) => {
      if (p.blocks[n]) {
        const el = document.querySelector(`[data-block="${i}-${n}"]`);
        if (el) {
          const r = el.getBoundingClientRect();
          const railRect = mapWorld.getBoundingClientRect();
          targets.push({
            x: (r.left + r.width / 2 - railRect.left) / view.scale,
            y: (r.top + r.height / 2 - railRect.top) / view.scale,
          });
        }
      }
    });
    for (let k = 0; k < targets.length - 1; k++) {
      parts.push(`<line x1="${targets[k].x}" y1="${targets[k].y}" x2="${targets[k + 1].x}" y2="${targets[k + 1].y}"
            stroke="#16a34a" stroke-width="1" stroke-dasharray="3,3" opacity="0.35"/>`);
    }
  }
  svg.innerHTML = parts.join('');
}
