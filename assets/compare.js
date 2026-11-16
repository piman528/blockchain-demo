/*
 * 3方式を並べて見る（Mock専用・サーバー通信なし）
 * 同じ「書き換え」「故障」を単一DB・DB＋ハッシュ・Fabricに同時にかけ、
 * 違いを動きで見せる。数値は説明用（PC01 の個数 5 → 20）。
 *
 * 時間の流れ（step）
 *   1 故障 / 2 値の書き換え / 3 自分の組織の基準 / 4 他の組織の基準
 *   5〜7 監査が基準を1つずつ照合 / 8 結果
 */
(function () {
  'use strict';

  const ATTACKS = ['なし', '値だけ', '自分の組織の分すべて', '2つの組織の分'];
  const FAULTS = ['なし', '1つ止める', '2つ止める'];
  const STAGES = ['故障', '書き換え', '監査', '結果'];
  const LAST = 8;
  const TICK = 750;

  const state = { attack: 0, fault: 0, step: LAST };
  let timer = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const LOCK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="触れない"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

  function play(patch) {
    Object.assign(state, patch || {}, { step: 0 });
    clearTimeout(timer);
    render();
    const tick = () => {
      state.step += 1;
      render();
      if (state.step < LAST) timer = setTimeout(tick, TICK);
    };
    timer = setTimeout(tick, 400);
  }

  // ---------- モデル ----------
  function model() {
    const { attack: a, fault: f, step: s } = state;
    const master = a >= 1 && s >= 2 ? 100 : 20;
    const finalMaster = a >= 1 ? 100 : 20;
    const faulted = s >= 1;

    function box(name, value, o = {}) {
      const down = !!o.down && faulted;
      let fx = '';
      if (o.down && s === 1) fx = 'fx-off';
      else if (o.changeAt && s === o.changeAt && value === 100) fx = o.copy ? 'fx-copy' : 'fx-flash';
      else if (o.scanAt && s === o.scanAt) fx = 'fx-scan';
      let cmp = null;
      if (o.scanAt && s >= o.scanAt && !down && a >= 1) {
        cmp = { ne: value !== finalMaster, fx: s === o.scanAt ? 'fx-pop' : '' };
      }
      return { name, value, hash: !!o.hash, chain: !!o.chain, down, bad: value === 100, fx, cmp };
    }
    function verdict(kind) {
      if (s < LAST) return { cls: '', text: '…', fx: s >= 5 ? 'fx-pulse' : '' };
      return {
        none: { cls: '', text: '異常なし' },
        pass: { cls: 'is-pass', text: 'すり抜けた' },
        caught: { cls: 'is-caught', text: '見つかった' },
        cannot: { cls: '', text: '確かめられない' }
      }[kind];
    }
    function writeV(ok) {
      if (s < LAST) return { cls: '', text: '…', fx: s >= 5 ? 'fx-pulse' : '' };
      return ok ? { cls: 'is-ok', text: '○' } : { cls: 'is-ng', text: '✕' };
    }
    const withStamp = (v) => (s === LAST ? Object.assign({ fx: 'fx-stamp' }, v) : v);

    // 単一DB：複製はマスタを自動でコピーする
    const sDM = f >= 1, sDR1 = f >= 2;
    // マスタが止まっていれば書き換え自体ができない
    const sMaster = !sDM && a >= 1 && s >= 2 ? 100 : 20;
    const copyNow = (stopped) => (!stopped && !sDM && a >= 1 && s >= 3 ? 100 : 20);
    let sAudit;
    if (sDM) sAudit = 'cannot';
    else if (a === 0) sAudit = 'none';
    else {
      const refs = (sDR1 ? [] : [a >= 1 ? 100 : 20]).concat([a >= 1 ? 100 : 20]);
      sAudit = refs.every((v) => v === finalMaster) ? 'pass' : 'caught';
    }
    const single = {
      name: '単一DB',
      groups: [{ own: true, boxes: [
        box('マスタ', sMaster, { down: sDM, changeAt: 2 }),
        box('複製1', copyNow(sDR1), { down: sDR1, changeAt: 3, copy: true, scanAt: 5 }),
        box('複製2', copyNow(false), { changeAt: 3, copy: true, scanAt: 6 })
      ] }],
      audit: withStamp(verdict(sAudit)), write: withStamp(writeV(!sDM))
    };

    // DB＋ハッシュ：ハッシュはマスタと同じデータベースの中
    const hD = f >= 1;
    const hMaster = !hD && a >= 1 && s >= 2 ? 100 : 20;
    const hashNow = !hD && a >= 2 && s >= 3 ? 100 : 20;
    const hashFinal = a >= 2 ? 100 : 20;
    const hAudit = hD ? 'cannot' : (a === 0 ? 'none' : (hashFinal === finalMaster ? 'pass' : 'caught'));
    const hash = {
      name: 'DB＋ハッシュ',
      groups: [{ own: true, boxes: [
        box('マスタ', hMaster, { down: hD, changeAt: 2 }),
        box('ハッシュ', hashNow, { hash: true, down: hD, changeAt: 3, scanAt: 5 })
      ] }],
      audit: withStamp(verdict(hAudit)), write: withStamp(writeV(!hD))
    };

    // Fabric：台帳は3台。VM2・VM3 は他の組織
    const d1 = f >= 1, d2 = f >= 2;
    const l1 = a >= 2 && s >= 3 ? 100 : 20;
    const l2 = a >= 3 && s >= 4 ? 100 : 20;
    const finalL = [a >= 2 ? 100 : 20, a >= 3 ? 100 : 20, 20];
    const up = [!d1, !d2, true];
    let fAudit = 'none';
    if (a >= 1) {
      const vals = finalL.filter((v, i) => up[i]);
      const same = vals.filter((v) => v === finalMaster).length;
      fAudit = same * 2 > vals.length ? 'pass' : 'caught';
    }
    const fabric = {
      name: 'ブロックチェーン',
      groups: [
        { own: true, boxes: [
          box('マスタ', master, { changeAt: 2 }),
          box('VM1 台帳', l1, { chain: true, down: d1, changeAt: 3, scanAt: 5 })
        ] },
        { own: false, locked: a < 3, shake: a === 2 && s === 4, boxes: [
          box('VM2 台帳', l2, { chain: true, down: d2, changeAt: 4, scanAt: 6 }),
          box('VM3 台帳', 20, { chain: true, scanAt: 7 })
        ] }
      ],
      audit: withStamp(verdict(fAudit)), write: withStamp(writeV(up.filter(Boolean).length >= 2))
    };

    return [single, hash, fabric];
  }

  // ---------- 描画 ----------
  function boxHtml(b) {
    const cls = ['cmp-box', b.bad ? 'is-bad' : '', b.down ? 'is-down' : '', b.fx].filter(Boolean).join(' ');
    const shown = b.hash ? '#' + b.value : String(b.value);
    const cmp = b.cmp ? `<span class="cmp-cmp ${b.cmp.ne ? 'is-ne' : ''} ${b.cmp.fx}">${b.cmp.ne ? '≠' : '＝'}</span>` : '';
    const down = b.down ? '<span class="cmp-box-down">停止</span>' : '';
    const body = b.chain
      ? `<div class="cmp-chain"><span class="cmp-blk">5</span><span class="cmp-arrow" aria-hidden="true">→</span><span class="cmp-blk ${b.bad ? 'is-bad' : ''}">${esc(shown)}</span></div>`
      : `<div class="cmp-val">${esc(shown)}</div>`;
    return `<div class="${cls}"><div class="cmp-box-head"><span class="cmp-box-name">${esc(b.name)}</span>${cmp}${down}</div>${body}</div>`;
  }
  function groupHtml(g) {
    const cls = ['cmp-group', g.own ? 'is-own' : 'is-other', g.shake ? 'fx-shake' : ''].filter(Boolean).join(' ');
    const lock = g.locked ? `<span class="${g.shake ? 'fx-lock' : ''}">${LOCK_SVG}</span>` : '';
    return `<div class="${cls}"><div class="cmp-group-label">${lock}<span>${g.own ? 'あなたの組織' : '他の組織'}</span></div>${g.boxes.map(boxHtml).join('')}</div>`;
  }
  function resHtml(label, r) {
    return `<div class="cmp-res ${r.cls} ${r.fx || ''}"><div class="cmp-res-k">${label}</div><div class="cmp-res-v">${esc(r.text)}</div></div>`;
  }
  function render() {
    const s = state.step;
    const stageIdx = s >= 8 ? 3 : s >= 5 ? 2 : s >= 2 ? 1 : s >= 1 ? 0 : -1;
    $('cmpStages').innerHTML = STAGES.map((l, i) => {
      const st = i === stageIdx ? 'is-active' : i < stageIdx ? 'is-done' : '';
      const arrow = i > 0 ? '<span class="demo-story-arrow" aria-hidden="true">→</span>' : '';
      return `<li class="demo-story-step ${st}">${arrow}<span class="demo-story-num">${i + 1}</span>${l}</li>`;
    }).join('');
    $('cmpAttack').innerHTML = ATTACKS.map((l, i) => `<button type="button" class="cmp-opt" data-attack="${i}" aria-pressed="${i === state.attack}">${l}</button>`).join('');
    $('cmpFault').innerHTML = FAULTS.map((l, i) => `<button type="button" class="cmp-opt" data-fault="${i}" aria-pressed="${i === state.fault}">${l}</button>`).join('');
    $('cmpCols').innerHTML = model().map((c) => `
      <section class="cmp-col" aria-label="${c.name}">
        <h2>${c.name}</h2>
        <div class="cmp-groups">${c.groups.map(groupHtml).join('')}</div>
        <div class="cmp-results">${resHtml('監査', c.audit)}${resHtml('書き込み', c.write)}</div>
      </section>`).join('');
  }

  function bind() {
    document.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.attack !== undefined) play({ attack: Number(t.dataset.attack) });
      else if (t.dataset.fault !== undefined) play({ fault: Number(t.dataset.fault) });
      else if (t.id === 'cmpReplay') play();
    });
  }

  function init() { bind(); render(); }
  // 台帳マップの「3方式比較」タブから呼び出す
  window.CompareView = { play: play, render: render };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
