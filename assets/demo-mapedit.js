/* ==========================================================================
   demo-mapedit.js — 台帳マップを直接触って、不正な書き換え・障害を起こす
   ・操作パネルは「登録・正規の更新・削除」だけに使う
   ・記録／保存したハッシュ／台帳（ブロック）／状態DB はセルをクリックして直接書き換える
   ・サーバー（VM）は、マップの VM の札をクリックして止める・動かす
   シナリオ中（body[data-learn]）は demo-scenario.js が操作を受け持つので、ここでは何もしない。
   core / c03 / c01c02 / api / bind / compare の各スクリプトより後に読み込む。
   ========================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isLearn = () => Boolean(document.body.dataset.learn);

  // ---------- 小さな通知 ----------
  function toast(msg) {
    let t = $('meToast');
    if (!t) {
      document.body.insertAdjacentHTML('beforeend', '<div class="scn-toast" id="meToast"></div>');
      t = $('meToast');
    }
    t.textContent = msg;
    t.classList.add('is-show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('is-show'), 3200);
  }

  // ---------- その場の入力欄 ----------
  let pending = null;
  function closeEditor() { const ed = $('meEditor'); if (ed) ed.remove(); pending = null; }
  function openEditor(anchor, { title, body, value, onOk, okLabel = '書き換える', numeric = true }) {
    closeEditor();
    const rc = anchor.getBoundingClientRect();
    document.body.insertAdjacentHTML('beforeend', `
      <div class="scn-editor" id="meEditor">
        <div class="scn-ed-title">${esc(title)}</div>
        ${body ? `<p>${body}</p>` : ''}
        ${numeric ? `<label>個数 <input type="number" id="meEdInput" min="0" step="1" value="${esc(value)}"> 台</label>` : ''}
        <div class="scn-ed-msg" id="meEdMsg"></div>
        <div class="scn-ed-actions"><button type="button" class="scn-btn" data-me-ok>${esc(okLabel)}</button><button type="button" class="scn-btn is-ghost" data-me-cancel>やめる</button></div>
      </div>`);
    const ed = $('meEditor');
    const w = ed.offsetWidth; const h = ed.offsetHeight;
    let left = rc.left + rc.width / 2 - w / 2;
    let top = rc.bottom + 10;
    if (top + h > window.innerHeight - 10) top = rc.top - h - 10;
    left = Math.max(10, Math.min(window.innerWidth - w - 10, left));
    ed.style.left = `${left}px`;
    ed.style.top = `${Math.max(10, top)}px`;
    pending = { onOk, numeric };
    const input = $('meEdInput');
    if (input) { input.focus(); input.select(); }
  }
  function confirmEditor() {
    if (!pending) return;
    let v = null;
    if (pending.numeric) {
      v = Number($('meEdInput').value);
      if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) { $('meEdMsg').textContent = '0 以上の整数を入れてください。'; return; }
    }
    const fn = pending.onOk;
    closeEditor();
    fn(v);
  }

  function snapWithQty(snap, qty) {
    return { id: snap.id, name: snap.name || '', category: snap.category || '', quantity: qty, location: snap.location || '', status: snap.status || '' };
  }
  function liveNote() {
    if (typeof liveMode !== 'undefined' && liveMode) toast('この書き換えは画面上だけです（実際の台帳は変わりません）');
  }

  // ---------- 記録（マスタ）の個数を直接書き換える ----------
  function tamperRecord(id, qty) {
    const item = masterItems[id];
    if (!item) return;
    if (typeof liveMode !== 'undefined' && liveMode) {
      // 実データでは書き換える値をサーバーが決める。前の書き換えが残っている間は次を受け付けない
      void (async () => {
        const status = await fetchJson('/admin/api/demo/tamper-status').catch(() => ({ pending: false }));
        if (status.pending) {
          toast('前の書き換えがまだ元に戻っていません。操作パネルの「リセット」で元に戻してから試してください');
          return;
        }
        const sel = $('opTarget');
        if (sel) sel.value = id;
        if (typeof tamperMasterLive === 'function') await tamperMasterLive();
      })();
      return;
    }
    const before = item.quantity;
    if (qty === before) { toast('同じ値です'); return; }
    if (!item._tampered) item._tamperedFromQty = before;
    item.quantity = qty;
    item._tampered = true;
    item._updated = true;
    item._verify = null;
    comparisonVerified = false;
    // データベースの複製には、書き換えた値もそのまま写される
    slaveDbItems.forEach((_, i) => { slaveDbItems[i][id] = snapshotForReplication(item); });
    if (typeof showTamperingAlert === 'function') showTamperingAlert('master');
    announceChange(`記録を直接書き換え（${id}：${before} → ${qty}）— 申請を通していないので、照合の手がかりは古いまま`, 'danger', 5200);
    pushLog(`記録の直接書き換え: ${id}.quantity ${before} → ${qty}`, 'err');
    render();
    document.dispatchEvent(new CustomEvent('demo:master:tampered', { detail: { id, quantity: qty, fromQuantity: before } }));
    scheduleAutoVerify(activeScenario === 'c01' || activeScenario === 'c02' ? 900 : 450);
  }

  // ---------- 保存したハッシュを、いまの記録に合わせて書き換える ----------
  function tamperStoredHash(id) {
    const item = masterItems[id];
    if (!item) return;
    liveNote();
    syncLocalHashStore(item, { tampered: true });
    c02TamperMode = 'B';
    comparisonVerified = false;
    announceChange(`保存したハッシュを直接書き換え（${id}）— いまの記録から計算した値に合わせました`, 'danger', 5200);
    pushLog(`保存したハッシュの直接書き換え: ${id}`, 'err');
    render();
    scheduleAutoVerify(600);
  }

  // ---------- 台帳（ブロック）を書き換える：その台の中ではつじつまが合うように計算し直す ----------
  function tamperBlock(peerIndex, blockIndex, tx, qty) {
    const peer = peers[peerIndex];
    if (!peer) return;
    liveNote();
    let note;
    try { note = JSON.parse(tx.record.note); } catch (_) { return; }
    if (!note.snap) return;
    const before = note.snap.quantity;
    note.snap.quantity = qty;
    note.af = hashItem(snapWithQty(note.snap, qty));
    tx.record.note = JSON.stringify(note);
    tx.record._tampered = true;
    for (let i = blockIndex; i < peer.blocks.length; i++) {
      const b = peer.blocks[i];
      if (i > blockIndex) b.prevHash = peer.blocks[i - 1].hash;
      b.hash = recomputeBlockHash(b);
    }
    // 書き換えたのがその備品の最新の記録なら、状態DB も合わせる
    const id = tx.record.targetId;
    const latest = findLatestLedgerSnapshot(peer, id);
    const key = `ITEM-${id}`;
    if (latest && Number(latest.quantity) === qty && peer.worldState[key]) {
      peer.worldState[key].value = { ...peer.worldState[key].value, quantity: qty, af: note.af, _tampered: true };
      peer.worldState[key].updated = true;
    }
    peer.tampered = true;
    comparisonVerified = false;
    announceChange(`${peer.name} の台帳を書き換え（ブロック #${peer.blocks[blockIndex].num}：個数 ${before} → ${qty}）— ブロックの値も計算し直したので、${peer.name} の中ではつじつまが合っています`, 'danger', 5600);
    pushLog(`${peer.name} ブロック#${peer.blocks[blockIndex].num} を書き換え（${id} 個数 ${before} → ${qty}、ハッシュも再計算）`, 'err');
    render();
    scheduleAutoVerify(600);
  }

  // ---------- 状態DB を書き換える（ブロックはそのまま） ----------
  function tamperState(peerIndex, key, qty) {
    const peer = peers[peerIndex];
    const entry = peer && peer.worldState[key];
    if (!entry) return;
    liveNote();
    const id = key.replace(/^ITEM-/, '');
    const snap = findLatestLedgerSnapshot(peer, id) || masterItems[id] || { id };
    const before = entry.value.quantity;
    entry.value = { ...entry.value, quantity: qty, af: hashItem(snapWithQty(snap, qty)), _tampered: true };
    entry.updated = true;
    peer.couchTampered = true;
    comparisonVerified = false;
    announceChange(`${peer.name} の状態DB を書き換え（${key}：${before} → ${qty}）— ブロックの記録はそのまま`, 'danger', 5200);
    pushLog(`${peer.name} 状態DB[${key}] の個数 ${before} → ${qty}`, 'err');
    render();
    scheduleAutoVerify(600);
  }

  // ---------- サーバー（VM）を止める・動かす ----------
  function isNodeUp(i) {
    if (typeof isMockFailureMode === 'function' && isMockFailureMode()) return getMockNodeStates()[i] !== false;
    if (typeof getPeerConnectionStatus === 'function') return !getPeerConnectionStatus(i).down;
    return true;
  }
  function openNodeMenu(anchor, i) {
    const up = isNodeUp(i);
    const name = peers[i]?.name || `VM${i + 1}`;
    openEditor(anchor, {
      title: `${name}（サーバー）`,
      body: up ? 'いまは動いています。' : 'いまは止まっています。',
      numeric: false,
      okLabel: up ? 'このサーバーを止める' : 'このサーバーを動かす',
      onOk: () => { void nodeAction(i, !up); },
    });
  }
  async function nodeAction(i, toUp) {
    const name = peers[i]?.name || `VM${i + 1}`;
    if (!(typeof liveMode !== 'undefined' && liveMode) && !mockFailureMode) mockFailureMode = true;
    const isMock = typeof isMockFailureMode === 'function' && isMockFailureMode();
    const id = isMock ? `mock-vm${i + 1}-${toUp ? 'start' : 'stop'}` : `vm${i + 1}-${toUp ? 'start' : 'stop'}`;
    await runNodeFailureAction(id, `${name} を${toUp ? '起動' : '停止'}`);
    const msg = ($('nodeOpsResult')?.textContent || '').trim();
    if (msg) announceChange(msg, toUp ? 'ok' : 'danger', 5200);
    render();
  }

  // ---------- クリックの振り分け ----------
  let down = null;
  document.addEventListener('mousedown', (e) => { down = { x: e.clientX, y: e.clientY }; }, true);

  function onClick(e) {
    if (isLearn()) return;
    const t = e.target;
    if (t.closest('#meEditor')) {
      const b = t.closest('button');
      if (b && b.hasAttribute('data-me-ok')) confirmEditor();
      else if (b && b.hasAttribute('data-me-cancel')) closeEditor();
      return;
    }
    if (!t.closest('#mapStage, #masterList')) { closeEditor(); return; }
    // ドラッグでマップを動かしたときは何もしない
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    if (t.closest('button, a, input, select')) return;

    let handled = true;
    const masterQty = t.closest('[data-db-lane="master"] td.cell-qty');
    const masterCard = t.closest('#masterList [data-master] .master-field');
    const slaveQty = t.closest('[data-db-lane^="slave"] td.cell-qty');
    const storedHash = t.closest('[data-hash-lane="master"] td.cell-stored-hash');
    const slaveHash = t.closest('[data-hash-lane^="slave"] td.cell-stored-hash');
    const label = t.closest('.peer-label');
    const kv = t.closest('.couchdb .kv-row.is-item');
    const block = t.closest('.peer-rail > .block:not(.is-genesis)');

    if (masterQty || (masterCard && /個数/.test(masterCard.textContent))) {
      const row = t.closest('[data-db-row]');
      const id = row ? row.dataset.dbRow : t.closest('[data-master]').dataset.master;
      const item = masterItems[id];
      if (!item) return;
      openEditor(masterQty || masterCard, {
        title: `記録の「個数」を直接書き換える（${id}）`,
        body: (typeof liveMode !== 'undefined' && liveMode) ? '実データでは、書き換える値はサーバーが決めます。' : '',
        value: item.quantity,
        numeric: !(typeof liveMode !== 'undefined' && liveMode),
        onOk: (v) => tamperRecord(id, v),
      });
    } else if (slaveQty || slaveHash) {
      toast('複製は、記録（マシン1）から自動で写されます。書き換えるならマシン1 を触ってください');
    } else if (storedHash) {
      const id = storedHash.dataset.itemId;
      if (!masterItems[id]) return;
      openEditor(storedHash, {
        title: `「保存した値」（ハッシュ）を直接書き換える（${id}）`,
        body: `保存した値を、いまの記録（${masterItems[id].quantity}台）から計算したハッシュに置き換えます。`,
        numeric: false,
        onOk: () => tamperStoredHash(id),
      });
    } else if (label) {
      const i = Number((label.id || '').replace('peerLabel', ''));
      if (Number.isInteger(i)) openNodeMenu(label, i); else handled = false;
    } else if (kv) {
      const lane = kv.closest('.peer-lane');
      const i = Number((lane?.id || '').replace('peerLane', ''));
      const key = kv.querySelector('.kv-key')?.textContent.trim();
      const entry = peers[i]?.worldState[key];
      if (!entry) return;
      openEditor(kv, {
        title: `${peers[i].name} の状態DB（${key}）を書き換える`,
        value: entry.value.quantity,
        onOk: (v) => tamperState(i, key, v),
      });
    } else if (block) {
      const lane = block.closest('.peer-lane');
      const i = Number((lane?.id || '').replace('peerLane', ''));
      const [pi, num] = (block.dataset.block || '').split('-').map(Number);
      const peer = peers[pi];
      const bi = peer ? peer.blocks.findIndex((b) => b.num === num) : -1;
      if (!peer || bi < 0 || pi !== i) return;
      const tx = peer.blocks[bi].txs.find((x) => x.record && x.record.targetId && isItemLedgerEvent(x.record.eventType));
      if (!tx) { toast('このブロックには備品の記録がありません'); return; }
      let qty = '';
      try { qty = JSON.parse(tx.record.note).snap.quantity; } catch (_) { /* 個数のない記録 */ }
      openEditor(block, {
        title: `${peer.name} の台帳（ブロック #${num}）の個数を書き換える`,
        body: 'ブロックの値も計算し直して、この台の中ではつじつまが合うようにします。',
        value: qty,
        onOk: (v) => tamperBlock(pi, bi, tx, v),
      });
    } else handled = false;
    if (handled) { e.stopPropagation(); e.preventDefault(); }
  }
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', (e) => {
    if (!pending) return;
    if (e.key === 'Enter' && e.target.id === 'meEdInput') { e.preventDefault(); confirmEditor(); }
    if (e.key === 'Escape') closeEditor();
  });
})();
