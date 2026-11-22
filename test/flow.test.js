// 三明治架构的中间层：流程解锁、法定必填项、请求句式、事实与理由校验、工资平均数
const test = require('node:test');
const assert = require('node:assert');
const W = require('../engine/flow.js');
const D = require('../engine/docs.js');
const E = require('../engine/engine.js');

const base = { facts: {}, pending: {}, selected: [], conflicts: [], chosen: [], started: true };

test('模型读出的计算参数没确认前，测算之后的页面锁住', () => {
  const g = W.gates({ ...base, facts: { monthly_wage: 9000 }, pending: { monthly_wage: true }, selected: ['illegal_termination'] });
  assert.strictEqual(g.P3.open, true);
  assert.strictEqual(g.P4.open, false);
  assert.match(g.P4.why.join(), /月工资/);
  assert.strictEqual(g.P6.open, false);
});

test('确认后解锁；证据不足不锁申请书', () => {
  const chosen = [{ id: 'illegal_termination', title: '违法解除', tier: '需补证', calc: { amount: 54000 } }];
  const g = W.gates({ ...base, facts: { monthly_wage: 9000 }, selected: ['illegal_termination'], chosen });
  assert.strictEqual(g.P6.open, true);
});

test('互斥未处理时不能进测算', () => {
  const g = W.gates({ ...base, selected: ['a', 'b'], conflicts: [['违法解除赔偿金', '经济补偿']] });
  assert.strictEqual(g.P3.open, false);
});

test('申请书法定必填项：法定代表人必填', () => {
  const app = { applicant: { name: '张三', gender: '男', id_no: '1', address: 'x', phone: '1' }, respondent: { name: '某公司', address: 'y', legal_rep: '' }, reasons: '事实' };
  assert.deepStrictEqual(W.requiredMissing(app, [{ id: 'unpaid_wages' }]), ['被申请人法定代表人']);
});

test('请求句式金额来自代码，N 和代通知金有对应句式', () => {
  const lines = W.requestLines([{ id: 'economic_compensation', calc: { amount: 27000 } }, { id: 'notice_pay', calc: { amount: 9000 } }], E.yuan);
  assert.match(lines[0], /经济补偿金 27,?000/);
  assert.match(lines[1], /代通知金/);
});

test('事实与理由里出现金额或事实之外的日期会被拦下', () => {
  const facts = { start_date: '2022-03-01', end_date: '2025-07-15' };
  assert.deepStrictEqual(W.checkReasons('申请人于2022年3月1日入职，2025年7月15日被辞退。', facts), []);
  assert.ok(W.checkReasons('被申请人应支付赔偿金54000元。', facts).length);
  assert.ok(W.checkReasons('申请人于2021年5月入职。', facts).length);
});

test('工资条：平均月工资由代码按最近 12 个月应发算', () => {
  const months = Array.from({ length: 14 }, (_, i) => ({ month: `2024-${String((i % 12) + 1).padStart(2, '0')}`.replace(/^2024-(\d\d)$/, (m, mm) => i < 12 ? `2024-${mm}` : `2025-${mm}`), gross: i < 12 ? '10,000' : 12000, net: 8000 }));
  const avg = D.averageGross(months);
  assert.strictEqual(avg.months, 12);
  assert.strictEqual(avg.to, '2025-02');
  assert.ok(Math.abs(avg.value - (10 * 10000 + 2 * 12000) / 12) < 0.01);
  const st = { facts: {}, manual: {}, applicant: {}, respondent: {} };
  D.apply('wage', { months, monthly_wage: 99999 }, st);
  assert.strictEqual(st.facts.monthly_wage, avg.value);
});

test('当事人自己补充的细节里出现的日期，可以出现在事实与理由里', () => {
  const facts = { start_date: '2022-03-01' };
  assert.ok(W.checkReasons('2025年6月3日经理在微信里通知申请人。', facts).length);
  assert.deepStrictEqual(W.checkReasons('2025年6月3日经理在微信里通知申请人。', facts, ['6月份那次是2025年6月3日经理发微信说的']), []);
});
