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

test('合并记录：包含对话、补充细节、材料和证据，不含金额和待确认参数', () => {
  const rec = W.buildRecord({
    facts: { start_date: '2022-03-01', end_date: '2025-07-15', monthly_wage: 9000, company_name: '某公司' },
    pending: { end_date: true },
    chat: [{ role: 'ai', text: '你好' }, { role: 'user', text: '我被辞退了' }, { role: 'ai', text: '欠了多少？', type: 'number' }, { role: 'user', text: '9000' }],
    supplements: [{ text: '经理在微信里说明天别来了' }],
    recognized: [{ tag: '劳动合同', filled: ['公司名称'], note: '' }],
    evidence: { termination: ['辞退聊天记录'], wage: [] },
    chosen: [{ title: '违法解除劳动合同赔偿金', tier: '需补证', disputes: [], calc: { amount: 54000 } }],
  });
  assert.deepStrictEqual(rec.confirmed_facts, { start_date: '2022-03-01', company_name: '某公司' });
  assert.deepStrictEqual(rec.user_words, ['我被辞退了', '经理在微信里说明天别来了']);
  assert.deepStrictEqual(rec.evidence, ['辞退聊天记录']);
  assert.ok(!JSON.stringify(rec).includes('54000'));
});

test('用户原话里的金额不交给模型，日期保留', () => {
  assert.strictEqual(W.redactMoney('在苏州做了3年，月薪9000，还欠了两万块'), '在苏州做了3年，月薪[金额略]，还欠[金额略]');
  assert.strictEqual(W.redactMoney('2026年10月1日被辞退，工资8,500元'), '2026年10月1日被辞退，工资[金额略]');
});

test('信息链：对话里说的当事人信息写进申请书并记下来源，已填的不覆盖', () => {
  const st = { facts: {}, manual: {}, applicant: { name: '', phone: '' }, respondent: { name: '已填公司' }, sources: {} };
  const out = D.apply('chat', { applicant_name: '张三', applicant_phone: '13800000000', company_name: '某某公司' }, st, '你在对话里说的');
  assert.strictEqual(st.applicant.name, '张三');
  assert.strictEqual(st.applicant.phone, '13800000000');
  assert.strictEqual(st.respondent.name, '已填公司');
  assert.strictEqual(st.sources['applicant.phone'], '你在对话里说的');
  assert.strictEqual(st.sources.company_name, '你在对话里说的');
  assert.ok(out.filled.includes('电话'));
});

test('对话里说过的材料对应到证据标签', () => {
  assert.deepStrictEqual(D.impliedEvidence({ labor_proof: 'social', termination_form: 'chat', signed_contract: 'no' }), [['labor_relation', '社保缴费记录'], ['termination', '辞退聊天记录']]);
});

test('来源优先级：证照覆盖对话里说的地址，对话不覆盖证照', () => {
  const st = { facts: {}, manual: {}, applicant: { address: '' }, respondent: {}, sources: {} };
  D.apply('chat', { applicant_address: '苏州' }, st, '你在对话里说的');
  D.apply('id_card', { applicant_address: '江苏省苏州市吴中区某路 1 号' }, st, '身份证照片');
  assert.strictEqual(st.applicant.address, '江苏省苏州市吴中区某路 1 号');
  D.apply('chat', { applicant_address: '苏州园区' }, st, '你补充的');
  assert.strictEqual(st.sources['applicant.address'], '身份证照片');
});
