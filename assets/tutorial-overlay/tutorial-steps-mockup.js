// tutorial-steps-mockup.js — モック用ステップセット
// chapter は左上のモード名（C-01/C-02/C-03）と重複しない短い見出しにする
const TUTORIAL_STEPS_MOCKUP = [
  {
    id: '1-1-register',
    chapter: 'はじめに',
    title: '備品を追加しよう',
    body: '右の入力欄には、追加する備品の内容が入っています。<strong>「備品を登録」</strong>を押してください。<br>押すと、中央の3つの画面に同じ内容が表示されます。',
    scenario: 'c01',
    highlights: ['[data-tutorial-target="register-button"]'],
    scrollTargets: [
      '[data-tutorial-target="new-item-form"]',
      '[data-tutorial-target="register-button"]',
      '[data-tutorial-target="comparison-stage"]',
    ],
    waitFor: {
      event: 'demo:item:created',
      filter: (e) => e.detail.id === 'PC01',
    },
    onEnter() {
      prefillRegisterForm('PC01', 'ノートPC', 5);
    },
  },
  {
    id: '1-2-tamper',
    chapter: '書き換えを試す',
    title: '元の記録を勝手に変える',
    body: '右の <strong>「マスタだけ改ざん」</strong> を押してください。これは、いつもの更新手順を使わずに、元になる記録だけを勝手に変えた場合を表しています。<br><br>押したあと、<strong>マシン1の個数</strong>が赤い枠で <strong>5 → 100</strong> に変わることを見てください。',
    highlights: ['[data-tutorial-target="tamper-master-button"]'],
    scrollTargets: [
      '[data-tutorial-target="tamper-master-button"]',
      '[data-tutorial-target="db-lane-stack"]',
    ],
    waitFor: {
      event: 'demo:master:tampered',
      filter: (e) => e.detail.id === 'PC01',
      manualAdvance: true,
      afterBody: 'マシン1の個数が <strong>100（もとは5）</strong> に変わりました（赤い枠）。次は、この間違った個数がほかの2台にもコピーされる様子を見ます。確認できたら <strong>「次へ →」</strong> を押してください。',
      afterHighlights: [
        '[data-tutorial-target="tampered-qty-cell"]',
        '[data-db-lane="master"]',
      ],
      afterScrollTargets: [
        '[data-tutorial-target="tampered-qty-cell"]',
        '[data-db-lane="master"]',
      ],
    },
  },
  {
    id: '1-3-spread',
    chapter: '書き換えを試す',
    title: '間違った内容もコピーされる',
    body: '中央の3台を見てください。<strong>マシン1 → マシン2 → マシン3</strong> の順に、間違った個数（100）がコピーされていきます。<br><br>内容をそろえる仕組みは便利ですが、元の記録が変わると、間違った内容まで広がります。',
    highlights: ['[data-tutorial-target="db-lane-stack"]'],
    scrollTargets: [
      '[data-db-lane="master"]',
      '[data-db-lane="slave0"]',
      '[data-db-lane="slave1"]',
      '[data-tutorial-target="tampered-qty-cell"]',
    ],
    waitFor: { delayMs: 2500 },
  },
  {
    id: '1-4-verify',
    chapter: '結果を見る',
    title: '3台を比べても気づけない',
    body: '書き換えのあと、画面は3台の内容を自動で見比べます。中央の3台を見てください。<br><br>3台とも個数が100で同じなので、一見すると問題がないように見えます。けれど、正しい個数（5）を残しておく場所がないため、<strong>自動では間違いに気づけません</strong>。確認したら「次へ」を押してください。',
    highlights: ['[data-tutorial-target="db-lane-stack"]'],
    scrollTargets: [
      '[data-tutorial-target="comparison-stage"]',
      '[data-tutorial-target="db-lane-stack"]',
    ],
    waitFor: { manual: true },
  },
  {
    id: 'bridge-1',
    kind: 'modal',
    title: '正しい個数と比べられなかった',
    body: 'この方法では、元の記録が変わると、3台とも同じ間違った内容になります。そのため、<strong>勝手な書き換えに気づけませんでした</strong>。<br><br>次は、内容を確かめるための「確認用の数字」を別に残して、書き換えに気づけるか試します。右下の表示が切り替わります。',
    modalButton: '次の方式へ',
    scenario: 'c02',
  },
  {
    id: '2-1-register',
    chapter: 'はじめに',
    title: '2つの表を用意する',
    body: 'ここでは、備品の内容を入れる表（帳票A）と、内容が変わっていないか確かめるための数字を入れる表（帳票B）を、一緒に使います。右の入力欄で、もう一度PC01を登録してください。<br><br>押すと、各マシンのカードに2つの表が表示されます。',
    scenario: 'c02',
    highlights: ['[data-tutorial-target="register-button"]'],
    scrollTargets: [
      '[data-tutorial-target="new-item-form"]',
      '[data-tutorial-target="register-button"]',
      '[data-tutorial-target="comparison-stage"]',
    ],
    waitFor: {
      event: 'demo:item:created',
      filter: (e) => e.detail.id === 'PC01',
    },
    onEnter() {
      if (typeof TutorialEnvironment !== 'undefined') {
        TutorialEnvironment.reset();
        TutorialEnvironment.setScenario('c02');
      }
      prefillRegisterForm('PC01', 'ノートPC', 5);
    },
  },
  {
    id: '2-2-books',
    chapter: '画面の見方',
    title: '2つの表の役割を見る',
    body: '中央を見てください。各マシンには、2つの表があります。<br><br>・<strong>帳票A</strong> … 備品の内容と、その内容から作った「いまの確認用の数字」<br>・<strong>帳票B</strong> … 前に保存しておいた「確認用の数字」<br><br>真ん中の線は、この2つの数字を見比べる場所です。確認できたら「次へ」を押してください。',
    highlights: ['[data-tutorial-target="ledger-books-row"]'],
    scrollTargets: [
      '[data-tutorial-target="ledger-books-row"]',
    ],
    waitFor: { manual: true },
  },
  {
    id: '2-3-mode-a',
    chapter: '書き換え方を選ぶ',
    title: 'まずは内容だけを変える',
    body: '勝手に書き換える方法は2つあります。<br><br>・<strong>A</strong> … 備品の内容だけを変える。確認用の数字はそのまま<br>・<strong>B</strong> … 備品の内容と確認用の数字を一緒に変える<br><br>まずはAを試します。右側で <strong>「A」</strong> が選ばれていることを確認し、「次へ」を押してください。',
    highlights: ['[data-tutorial-target="c02-mode-a"]'],
    scrollTargets: ['[data-tutorial-target="c02-mode-a"]'],
    waitFor: { manual: true },
  },
  {
    id: '2-4-tamper',
    chapter: '書き換えを試す',
    title: '備品の内容だけを変える',
    body: 'Aを選んだまま、<strong>「マスタだけ改ざん」</strong>を押してください。<br><br>画面では次のように変わります。<br>・左の表（帳票A）の<strong>個数</strong>が 5 → 100（赤い枠）<br>・左の表の<strong>「いまの値」</strong>も変わる<br>・右の表（帳票B）の<strong>「保存した値」</strong>は前のまま（3台とも）',
    highlights: ['[data-tutorial-target="tamper-master-button"]'],
    scrollTargets: [
      '[data-tutorial-target="tamper-master-button"]',
      '[data-tutorial-target="ledger-books-row"]',
    ],
    waitFor: {
      event: 'demo:master:tampered',
      filter: (e) => e.detail.id === 'PC01',
      manualAdvance: true,
      afterBody: '左の表の個数と「いまの値」が変わりました。一方、右の表の「保存した値」は前のままです。この違いを、次に画面が自動で見比べます。確認できたら「次へ」を押してください。',
      afterHighlights: [
        '[data-tutorial-target="tampered-qty-cell"]',
        '[data-tutorial-target="entry-current-cell"]',
        '[data-tutorial-target="stored-hash-cell"]',
      ],
      afterScrollTargets: [
        '[data-tutorial-target="tampered-qty-cell"]',
        '[data-tutorial-target="entry-current-cell"]',
        '[data-tutorial-target="stored-hash-cell"]',
      ],
    },
  },
  {
    id: '2-5-verify',
    chapter: '結果を見る',
    title: '書き換えに気づけた',
    body: '書き換えのあと、画面が自動で2つの数字を見比べます。中央の線にある <strong>✗</strong> を見てください。<br><br>「保存した値」と「いまの値」が違うため、<strong>備品の内容だけが勝手に変えられたことに気づけます</strong>。確認したら「次へ」を押してください。',
    highlights: ['[data-tutorial-target="hash-compare-cell"]'],
    scrollTargets: [
      '[data-tutorial-target="hash-compare-cell"]',
    ],
    waitFor: { manual: true },
  },
  {
    id: '2-6-mode-b',
    chapter: '書き換えを試す',
    title: '確認用の数字も変える',
    body: '次は、内容を変えた人が確認用の数字まで変えた場合です。右側で <strong>「B」</strong> に切り替え、もう一度 <strong>「マスタだけ改ざん」</strong> を押してください。<br><br>今回は、備品の内容だけでなく、右の表の「保存した値」も新しい内容に合わせて変わり、ほかの2台にもコピーされます。',
    highlights: [
      '[data-tutorial-target="c02-mode-b"]',
      '[data-tutorial-target="tamper-master-button"]',
    ],
    scrollTargets: [
      '[data-tutorial-target="c02-mode-b"]',
      '[data-tutorial-target="tamper-master-button"]',
      '[data-tutorial-target="stored-hash-cell"]',
    ],
    waitFor: {
      event: 'demo:master:tampered',
      filter: (e) => {
        if (e.detail.id !== 'PC01') return false;
        if (e.detail.c02TamperMode !== 'B') return false;
        const item = masterItems.PC01;
        if (!item) return false;
        const local = localHashStore.PC01;
        const currentHash = hashItem(item);
        return local && local.hash === currentHash;
      },
      manualAdvance: true,
      afterBody: 'Bでは、内容を変えるのと同時に「保存した値」も「いまの値」と同じになりました。2つの数字だけを比べると同じに見えるので、次で確かめます。',
      afterHighlights: [
        '[data-tutorial-target="c02-mode-b"]',
        '[data-tutorial-target="stored-hash-cell"]',
        '[data-tutorial-target="entry-current-cell"]',
      ],
      afterScrollTargets: [
        '[data-tutorial-target="c02-mode-b"]',
        '[data-tutorial-target="stored-hash-cell"]',
        '[data-tutorial-target="entry-current-cell"]',
      ],
    },
  },
  {
    id: '2-7-reverify',
    chapter: '結果を見る',
    title: '同じ場所の2つだけでは気づけない',
    body: '中央の線にある <strong>✓</strong> を見てください。<br><br>備品の内容と確認用の数字がどちらも変えられているため、2つを比べても<strong>同じに見えてしまいます</strong>。確認用の数字も同じ場所にあると、一緒に変えられてしまい、勝手な書き換えに気づけません。確認したら「次へ」を押してください。',
    highlights: ['[data-tutorial-target="hash-compare-cell"]'],
    scrollTargets: [
      '[data-tutorial-target="hash-compare-cell"]',
    ],
    waitFor: { manual: true },
  },
  {
    id: 'bridge-2',
    kind: 'modal',
    title: '確認用の数字まで変えられると…',
    body: '確認用の数字が残っていれば、書き換えに気づける場合があります。しかし、その数字まで一緒に変えられると気づけません。<br><br>次は、確認用の数字を元の記録とは<strong>別の場所</strong>に残し、簡単には変えられないようにする方法を見ます。右下の表示が切り替わります。',
    modalButton: '次の方式へ',
    scenario: 'c03',
  },
  {
    id: '3-1-register',
    chapter: 'はじめに',
    title: '別の場所にも記録を残す',
    body: 'ここでは、同じ記録を3台で持ちます。右の入力欄でPC01を登録してください。<br><br>登録すると、中央に記録の箱（ブロック）が1つ増え、3台すべてに同じ記録が表示されます。備品の内容とは別の場所にも、確認に使う記録が残ることが大切です。',
    scenario: 'c03',
    highlights: ['[data-tutorial-target="register-button"]'],
    scrollTargets: [
      '[data-tutorial-target="new-item-form"]',
      '[data-tutorial-target="register-button"]',
      '[data-tutorial-target="map-stage"]',
    ],
    waitFor: {
      event: 'demo:item:created',
      filter: (e) => e.detail.id === 'PC01',
    },
    onEnter() {
      if (typeof TutorialEnvironment !== 'undefined') {
        TutorialEnvironment.reset();
        TutorialEnvironment.setScenario('c03');
      }
      prefillRegisterForm('PC01', 'ノートPC', 5);
    },
  },
  {
    id: '3-2-af',
    chapter: '画面の見方',
    title: '確認用の数字がある場所を見る',
    body: '中央の <strong>「ブロック #0」</strong> を開き、<strong>「監査用の値」</strong>の行を見てください。<br><br>これは、備品の内容から作った確認用の数字です。この数字は、左の備品の一覧とは<strong>別の場所</strong>に残されています。左の「ブロックの見方」でも確認できます。確認したら「次へ」を押してください。',
    highlights: ['[data-block="0-0"] [data-tutorial-target="block-af-row"]'],
    scrollTargets: [
      '[data-block="0-0"] [data-tutorial-target="block-af-row"]',
    ],
    waitFor: { manual: true },
  },
  {
    id: '3-3-tamper',
    chapter: '書き換えを試す',
    title: '元の記録だけを変える',
    body: 'これまでと同じく、<strong>「マスタだけ改ざん」</strong>を押してください。<br><br>左の備品一覧の個数は変わりますが、<strong>記録の箱にある「監査用の値」は変わりません</strong>。この場所の記録は、決められた手順でしか更新できないためです。',
    highlights: ['[data-tutorial-target="tamper-master-button"]'],
    scrollTargets: [
      '[data-tutorial-target="tamper-master-button"]',
      '[data-master="PC01"]',
    ],
    waitFor: { event: 'demo:master:tampered' },
  },
  {
    id: '3-4-verify',
    chapter: '結果を見る',
    title: '違いに気づけた',
    body: '書き換えのあと、画面が自動で2つの数字を見比べます。左の備品一覧と、記録の箱にある「監査用の値」を見てください。<br><br>・今の個数（100）から作った確認用の数字<br>・書き換える前に残した確認用の数字<br><br>この2つが違うため、<strong>元の記録だけが勝手に変えられたことに気づけます</strong>。確認したら「次へ」でまとめに進みます。',
    highlights: [
      '[data-master="PC01"]',
      '[data-block="0-0"] [data-tutorial-target="block-af-row"]',
    ],
    scrollTargets: [
      '[data-master="PC01"]',
      '[data-block="0-0"] [data-tutorial-target="block-af-row"]',
    ],
    waitFor: { manual: true },
  },
  {
    id: 'finish',
    kind: 'modal',
    title: 'まとめ',
    summary: true,
    body: '確認用の数字をどこに残すかで、勝手な書き換えに気づけるかが変わります。表を見て、どの方法なら気づけるかを確認してください。',
  },
];

function prefillRegisterForm(id, name, qty) {
  const idEl = document.getElementById('newItemId');
  const nameEl = document.getElementById('newItemName');
  const qtyEl = document.getElementById('newItemQuantity');
  if (idEl) idEl.value = id;
  if (nameEl) nameEl.value = name;
  if (qtyEl) qtyEl.value = String(qty);
}
