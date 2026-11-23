const test = require('node:test');
const assert = require('node:assert');
const A = require('../engine/assist.js');

test('问答：知识库只收已核法条和常见问题；回答里编造的金额被拦下', () => {
  const kb = A.kb({ city: '上海', application_format: { online_note: '只能窗口提交' } });
  assert.ok(kb.some(e => e.id === 'LCL-82'));
  assert.ok(kb.some(e => e.id === 'REGION' && /窗口/.test(e.text)));
  const ctx = { claims: [{ title: '拖欠工资', amount: '9,000 元' }] };
  assert.strictEqual(A.checkAnswer({ answer: '你能拿 50000 元' }, kb, ctx).ok, false);
  const ok = A.checkAnswer({ answer: '按代码算，欠薪是 9,000 元。仲裁不收费。', sources: ['FAQ-fee', 'NOPE'] }, kb, ctx);
  assert.ok(ok.ok);
  assert.deepStrictEqual(ok.sources, ['FAQ-fee']);
  assert.deepStrictEqual(ok.pending, ['FAQ-fee']);
});

test('录音关键句：只留文字稿里的原话（忽略标点空格），去掉带金额的说明', () => {
  const t = '老板：你明天不用来了，工资下个月再说。我：为什么？老板：没有为什么。';
  const q = A.checkQuotes({ quotes: [
    { quote: '你明天不用来了', speaker: '老板', shows: '公司提出让走' },
    { quote: '我们协商一致解除', speaker: '老板', shows: '编的' },
    { quote: '没有为什么', speaker: '老板', shows: '欠 9000 元' },
  ] }, t);
  assert.strictEqual(q.length, 2);
  assert.strictEqual(q[1].shows, '');
});

test('风险：两处原话都要在记录里，代码风险用模板', () => {
  const rec = { user_words: ['我是 2023 年 6 月入职的', '我 2024 年才进公司'], materials: [] };
  const r = A.checkRisks({ risks: [
    { a: '我是 2023 年 6 月入职的', b: '我 2024 年才进公司', tip: '入职时间要统一' },
    { a: '我是 2023 年 6 月入职的', b: '合同写的 2022 年', tip: '编的' },
  ] }, rec);
  assert.strictEqual(r.length, 1);
  const c = A.codeRisks({ eligibility: { items: [{ label: '时效', status: 'risk', daysLeft: 12, note: '还剩 12 天' }] }, asks: [], claims: [{ title: '违法解除', tier: '需补证', toSolid: ['补上「解除」类证据'] }] });
  assert.match(c[0].title, /12 天/);
  assert.match(c[1].text, /解除/);
});

test('证据时间线：按材料日期排，读不到日期的放最后，重复的不算', () => {
  const tl = A.evidenceTimeline([{ tag: 'B', doc_date: '2026-10-01' }, { tag: 'C' }, { tag: 'A', doc_date: '2023-06' }, { tag: 'D', doc_date: '2024-01-01', dup: true }]);
  assert.deepStrictEqual(tl.map(x => x.tag), ['A', 'B', 'C']);
});

test('开庭准备：去掉带金额的要点和清单外的证据', () => {
  const r = A.checkHearing({ items: [{ q: '你哪天入职的？', why: '确认工作年限', points: ['2023 年 6 月 1 日入职', '月薪 9000 元'], evidence: ['劳动合同', '工资条', '编的证据'] }] }, ['劳动合同', '工资条']);
  assert.deepStrictEqual(r[0].points, ['2023 年 6 月 1 日入职']);
  assert.deepStrictEqual(r[0].evidence, ['劳动合同', '工资条']);
});

test('协商参考：只能用代码给的金额，不许给折扣', () => {
  const money = { total: '171,000 元', items: [{ title: '违法解除', amount: '63,000 元' }] };
  const n = A.checkNegotiation({ points: ['按法律算，违法解除赔偿是 63,000 元', '可以接受 5 万元', '打八折也行'], script: '我想和公司谈一下离职补偿。', cautions: ['谈的过程留好记录'] }, money);
  assert.deepStrictEqual(n.points, ['按法律算，违法解除赔偿是 63,000 元']);
  assert.ok(n.script);
  assert.strictEqual(A.checkNegotiation({ points: ['给 99 元'] }, money), null);
});

test('金额按数值核对：数字碎片撞上不算', () => {
  assert.deepStrictEqual(A.moneyOutside('可以接受 3 万元', '{"total":"171,000 元","c":"37,500 元"}'), ['3 万元']);
  assert.deepStrictEqual(A.moneyOutside('一共 17.1 万元', '{"total":"171,000 元"}'), []);
});
