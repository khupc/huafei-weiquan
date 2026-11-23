const test = require('node:test');
const assert = require('node:assert');
const E = require('../engine/engine.js');
const F = require('../engine/facts.js');
const G = require('../rules/regions.js');

const TODAY = '2026-11-22';
// 报告里的示例案例：3 年 4 个月，月薪 9000，口头辞退没给理由，没签合同
const sample = {
  start_date: '2022-06-15', end_date: '2025-10-15', monthly_wage: 9000,
  separation: 'company_terminated', termination_form: 'oral', termination_reason: 'none',
  signed_contract: 'no', wages_owed: 'no',
};

test('工作年限：3 年 4 个月按 3.5', () => {
  assert.strictEqual(E.serviceYears('2022-06-15', '2025-10-15').n, 3.5);
});
test('工作年限：余数满 6 个月进 1', () => {
  assert.strictEqual(E.serviceYears('2022-01-01', '2024-07-01').n, 3);
  assert.strictEqual(E.serviceYears('2024-01-01', '2024-03-01').n, 0.5);
  assert.strictEqual(E.serviceYears('2023-01-01', '2025-01-01').n, 2);
});

test('违法解除 2N：9000 × 3.5 × 2 = 63000（和报告示例一致）', () => {
  const r = E.illegalTermination(sample, null);
  assert.strictEqual(r.amount, 63000);
  assert.match(r.formula, /31,500/);
  assert.ok(r.notes.some(n => n.includes('待补')));
});

test('校准文档例 1：2021-03-01 入职、2024-09-15 违法解除、月薪 9000 → 72000', () => {
  const r = E.illegalTermination({ start_date: '2021-03-01', end_date: '2024-09-15', monthly_wage: 9000 }, null);
  assert.strictEqual(r.n, 4);
  assert.strictEqual(r.amount, 72000);
});
test('校准文档封顶例：W 40000、S 12000、15 年 → 36000 × 12 × 2 = 864000', () => {
  const r = E.illegalTermination({ start_date: '2010-01-01', end_date: '2025-01-01', monthly_wage: 40000 }, { avg_wage: 12000 });
  assert.strictEqual(r.base, 36000);
  assert.strictEqual(r.n, 12);
  assert.strictEqual(r.amount, 864000);
});
test('没超过 3 倍社平的不封顶年限', () => {
  const r = E.compensation({ start_date: '2010-01-01', end_date: '2025-01-01', monthly_wage: 9000 }, { avg_wage: 12000 });
  assert.strictEqual(r.n, 15);
});
test('低于最低工资按最低工资', () => {
  const r = E.compensation({ start_date: '2024-01-01', end_date: '2025-01-01', monthly_wage: 1500 }, { min_wage: 2490 });
  assert.strictEqual(r.base, 2490);
});
test('月工资含加班费时给出保守值', () => {
  const r = E.illegalTermination({ start_date: '2021-03-01', end_date: '2024-09-15', monthly_wage: 9000, monthly_overtime: 1000 }, null);
  assert.strictEqual(r.amount, 72000);
  assert.strictEqual(r.conservative, 64000);
});
test('校准文档二倍工资例：2024-03-10 入职、2024-12-20 离职、月薪 8000 → 约 67310', () => {
  const r = E.doubleWage({ start_date: '2024-03-10', end_date: '2024-12-20', monthly_wage: 8000, signed_contract: 'no' }, null, '2024-12-25');
  assert.strictEqual(r.full, 8);
  assert.strictEqual(r.days, 9);
  assert.strictEqual(r.amount, 67310.34);
});
test('工作日计数', () => { assert.strictEqual(E.workdays('2024-12-10', '2024-12-20'), 9); });

test('二倍工资：最多 11 个月；全部超过一年时保守值为 0', () => {
  const r = E.doubleWage(sample, null, TODAY);
  assert.strictEqual(r.full, 11);
  assert.strictEqual(r.amount, 99000);
  assert.strictEqual(r.conservative, 0);
});
test('二倍工资：补订前一日截止', () => {
  const f = { ...sample, signed_contract: 'later', contract_signed_date: '2022-10-15' };
  const r = E.doubleWage(f, null, TODAY);
  assert.strictEqual(r.full, 3);
  assert.strictEqual(r.days, 0);
});

test('缺参数时不出金额，列出缺什么', () => {
  const r = E.illegalTermination({ start_date: '2022-01-01' }, null);
  assert.strictEqual(r.amount, null);
  assert.deepStrictEqual(r.lack, ['离职日期', '月工资']);
});

test('分析：示例案例列出违法解除、恢复劳动关系、二倍工资，不列拖欠工资', () => {
  const a = E.analyze(sample, null, {}, TODAY);
  const ids = a.claims.map(c => c.id).sort();
  assert.deepStrictEqual(ids, ['double_wage', 'illegal_termination', 'reinstatement']);
  // 没勾证据 → 需补证；二倍工资的月份超过一年前 → 有争议
  assert.strictEqual(a.claims.find(c => c.id === 'illegal_termination').tier, '需补证');
  assert.strictEqual(a.claims.find(c => c.id === 'double_wage').tier, '有争议');
});

test('分析：只有聊天记录仍需补证，有解除通知书才是基本稳', () => {
  const ev = { labor_relation: ['工资银行流水（单位付款）'], termination: ['辞退聊天记录'] };
  assert.strictEqual(E.analyze(sample, null, ev, TODAY).claims.find(c => c.id === 'illegal_termination').tier, '需补证');
  ev.termination.push('解除通知书');
  assert.strictEqual(E.analyze(sample, null, ev, TODAY).claims.find(c => c.id === 'illegal_termination').tier, '基本稳');
});
test('分析：签过离职文件、负责人事 → 有争议', () => {
  const a = E.analyze({ ...sample, signed_exit_doc: 'yes', hr_role: 'yes', end_date: '2026-10-01', start_date: '2026-01-01' }, null, {}, TODAY);
  assert.strictEqual(a.claims.find(c => c.id === 'illegal_termination').tier, '有争议');
  assert.strictEqual(a.claims.find(c => c.id === 'double_wage').tier, '有争议');
});

test('分析：公司说违纪 → 有争议', () => {
  const a = E.analyze({ ...sample, termination_reason: 'misconduct' }, null, {}, TODAY);
  assert.strictEqual(a.claims.find(c => c.id === 'illegal_termination').tier, '有争议');
});

test('分析：自己辞职不列违法解除；欠薪 + 辞职按被迫辞职列经济补偿 N（有争议）', () => {
  const a = E.analyze({ ...sample, separation: 'resigned', wages_owed: 'yes', wages_owed_amount: 12000 }, null, {}, TODAY);
  assert.ok(!a.claims.some(c => c.id === 'illegal_termination'));
  assert.strictEqual(a.claims.find(c => c.id === 'unpaid_wages').calc.amount, 12000);
  const n = a.claims.find(c => c.id === 'economic_compensation');
  assert.strictEqual(n.calc.amount, 31500);
  assert.strictEqual(n.tier, '有争议');
});
test('补偿判定：2N / N / N+代通知金 / 0', () => {
  const t = f => E.severance(f).type;
  assert.strictEqual(t({ separation: 'company_terminated', termination_reason: 'none' }), '2N');
  assert.strictEqual(t({ separation: 'company_terminated', termination_reason: 'incompetence', notice_30days: 'no' }), 'N+notice');
  assert.strictEqual(t({ separation: 'company_terminated', termination_reason: 'layoff' }), 'N');
  assert.strictEqual(t({ separation: 'mutual', mutual_initiator: 'company' }), 'N');
  assert.strictEqual(t({ separation: 'mutual', mutual_initiator: 'employee' }), '0');
  assert.strictEqual(t({ separation: 'resigned' }), '0');
});
test('不胜任解除且没提前通知：列出 N 和代通知金，和 2N 互斥', () => {
  const a = E.analyze({ ...sample, termination_reason: 'incompetence', notice_30days: 'no' }, null, {}, TODAY);
  const ids = a.claims.map(c => c.id);
  assert.ok(ids.includes('economic_compensation') && ids.includes('notice_pay') && ids.includes('illegal_termination'));
  assert.strictEqual(a.claims.find(c => c.id === 'notice_pay').calc.amount, 9000);
  assert.strictEqual(E.conflicts(['illegal_termination', 'notice_pay']).length, 1);
});

test('互斥：赔偿金和恢复劳动关系', () => {
  assert.strictEqual(E.conflicts(['illegal_termination', 'reinstatement']).length, 1);
  assert.strictEqual(E.conflicts(['illegal_termination', 'double_wage']).length, 0);
});

test('时效倒计时', () => {
  const a = E.analyze({ ...sample, end_date: '2026-10-21' }, null, {}, TODAY);
  assert.strictEqual(a.limitation.days, 32);
  assert.strictEqual(a.limitation.expired, false);
});

test('追问顺序：没说城市先问城市，再问离职方式；在职不问离职日期', () => {
  assert.strictEqual(F.nextSlot({}).key, 'city');
  assert.strictEqual(F.nextSlot({ city: '苏州' }).key, 'separation');
  const n = F.nextSlot({ city: '苏州', separation: 'still_employed', start_date: '2024-01-01' });
  assert.strictEqual(n.key, 'monthly_wage');
});
test('「不确定」一次换问法，两次跳过', () => {
  assert.strictEqual(F.nextSlot({ city: '苏州' }, { separation: 1 }).useAlt, true);
  assert.strictEqual(F.nextSlot({ city: '苏州' }, { separation: 2 }).key, 'start_date');
});

test('关键词兜底能读懂报告里的示例句', () => {
  const f = F.keywordExtract('在某市做了3年4个月仓库主管，月薪9000，上个月被口头通知明天别来了，没签过劳动合同，工资每月微信转账', TODAY);
  assert.strictEqual(f.monthly_wage, 9000);
  assert.strictEqual(f.separation, 'company_terminated');
  assert.strictEqual(f.termination_form, 'oral');
  assert.strictEqual(f.signed_contract, 'no');
  assert.strictEqual(f.end_date, '2026-10-01');
  assert.strictEqual(f.start_date, '2023-06-01');
});

test('地区表：覆盖全部省级单位，市级覆盖优先于省级默认', () => {
  assert.strictEqual(G.PROVINCES.length, 31);
  assert.ok(G.PROVINCES.reduce((s, p) => s + p.cities.length, 0) > 330);
  G.PROVINCE_DEFAULTS['广东省'].avg_wage[2025] = { value: 8000 };
  G.CITY_OVERRIDES['深圳'] = { avg_wage: { 2025: { value: 12000 } }, overtime_in_base: '是' };
  // 2026 年解除取 2025 年度（上年度）
  assert.strictEqual(G.standardsFor('深圳', '2026-03-01').avg_wage, 12000);
  assert.strictEqual(G.standardsFor('深圳', '2026-03-01').origin.avg_wage, '市级');
  assert.strictEqual(G.standardsFor('深圳', '2026-03-01').overtime_in_base, '是');
  assert.strictEqual(G.standardsFor('广州', '2026-03-01').origin.avg_wage, '省级');
  assert.strictEqual(G.standardsFor('广州', '2025-03-01').origin.avg_wage, '待补');
  assert.strictEqual(G.standardsFor('苏州', '2026-03-01').origin.avg_wage, '待补');
});

test('保守值按天切：跨过切点的月份只算切点之后的工作日', () => {
  // 2025-01-10 入职、未签、2026-02-01 离职（区间到 2026-01-09）；预计 2026-03-01 申请 → 切点 2025-03-01
  const f = { start_date: '2025-01-10', end_date: '2026-02-01', monthly_wage: 8700, signed_contract: 'no', filing_date: '2026-03-01' };
  const r = E.doubleWage(f, null, TODAY);
  assert.strictEqual(r.full, 11);
  // 区间 2025-02-10 起；第一段 2/10–3/9 只算 3/3–3/7 的 5 个工作日（3/1、3/2 是周末，3/8、3/9 是周末），其余 10 个整月
  assert.strictEqual(r.conservative, Math.round((8700 * 10 + 8700 / 21.75 * 5) * 100) / 100);
});
test('预计申请日推后，时效争议随之出现', () => {
  const f = { start_date: '2025-01-10', end_date: '2025-12-20', monthly_wage: 8700, signed_contract: 'no' };
  assert.strictEqual(E.doubleWage(f, null, '2026-01-05').conservative, undefined);
  assert.ok(E.doubleWage({ ...f, filing_date: '2026-03-01' }, null, '2026-01-05').conservative < 95700);
});

test('模块驱动追问：同一事实只问一次，并记下哪些请求要用', () => {
  const s = F.neededSlots({ city: '苏州' }).find(x => x.key === 'start_date');
  assert.deepStrictEqual([...new Set(s.usedBy)].sort(), ['经济补偿（N）', '未签书面劳动合同二倍工资差额', '违法解除劳动合同赔偿金'].sort());
});
test('模块排除后，它独有的事实不再问', () => {
  const keys = f => F.neededSlots(f).map(x => x.key);
  const signed = keys({ city: '苏州', signed_contract: 'yes' });
  assert.ok(!signed.includes('hr_role') && !signed.includes('refused_to_sign') && !signed.includes('labor_proof'));
  const resigned = keys({ city: '苏州', separation: 'resigned' });
  assert.ok(!resigned.includes('termination_reason') && resigned.includes('end_date'));
  assert.ok(!keys({ city: '苏州', wages_owed: 'no' }).includes('wages_owed_amount'));
});
test('一个案子同时命中三类请求', () => {
  const a = E.analyze({ ...sample, wages_owed: 'yes', wages_owed_amount: 5000 }, null, {}, TODAY);
  assert.deepStrictEqual(a.claims.map(c => c.id).sort(), ['double_wage', 'illegal_termination', 'reinstatement', 'unpaid_wages']);
});
test('前置条件：没签合同时问劳动关系材料，有材料则劳动关系要件满足', () => {
  assert.ok(F.neededSlots({ city: '苏州', signed_contract: 'no' }).some(x => x.key === 'labor_proof'));
  const a = E.analyze({ ...sample, labor_proof: 'payroll' }, null, {}, TODAY);
  assert.strictEqual(a.claims[0].elements.find(e => e.key === 'labor_relation').status, '已满足');
});
test('分流：工伤、平台用工、没有劳动关系材料', () => {
  assert.deepStrictEqual(E.analyze({ other_issues: ['work_injury'] }, null, {}, TODAY).routes.map(r => r.id), ['work_injury']);
  assert.deepStrictEqual(E.analyze({ labor_proof: 'none' }, null, {}, TODAY).routes.map(r => r.id), ['confirm_relation']);
  const kw = F.keywordExtract('我是外卖骑手，送餐时摔伤了', TODAY);
  assert.deepStrictEqual(kw.other_issues.sort(), ['platform_work', 'work_injury']);
});

test('劳动关系材料：社保/工资流水满足，工牌考勤初步满足，工作群聊天不够', () => {
  const st = p => E.analyze({ ...sample, labor_proof: p }, null, {}, TODAY).claims[0].elements.find(e => e.key === 'labor_relation').status;
  assert.strictEqual(st('social'), '已满足');
  assert.strictEqual(st('badge'), '初步满足');
  assert.strictEqual(st('chat'), '还需证据');
});
test('月计薪天数 D 取地区参数', () => {
  const f = { start_date: '2024-03-10', end_date: '2024-12-20', monthly_wage: 8000, signed_contract: 'no' };
  const r = E.doubleWage(f, { monthly_workdays: 20 }, '2024-12-25');
  assert.strictEqual(r.amount, Math.round((8 * 8000 + 8000 / 20 * 9) * 100) / 100);
});
test('分流：派遣、挂靠单列，不触发确认劳动关系', () => {
  const kw = F.keywordExtract('我是劳务派遣过去的', TODAY);
  assert.deepStrictEqual(E.analyze(kw, null, {}, TODAY).routes.map(r => r.id), ['dispatch']);
  assert.deepStrictEqual(E.analyze(F.keywordExtract('跟着包工头干活', TODAY), null, {}, TODAY).routes.map(r => r.id), ['subcontract']);
});

const D = require('../engine/docs.js');
test('材料识别：劳动合同写入公司信息和事实，不覆盖手改和已填的', () => {
  const state = { facts: { start_date: '2023-06-01', monthly_wage: 9000 }, manual: { monthly_wage: true }, applicant: { name: '', gender: '', id_no: '', address: '' }, respondent: { name: '已填公司', address: '', legal_rep: '', credit_code: '' } };
  const out = D.apply('contract', { company_name: '苏州某某物流有限公司', company_address: '苏州工业园区', legal_rep: '王某', start_date: '2022-06-15', monthly_wage: '8,000', applicant_name: '张三' }, state);
  assert.strictEqual(state.respondent.name, '已填公司');
  assert.strictEqual(state.respondent.address, '苏州工业园区');
  assert.strictEqual(state.applicant.name, '张三');
  assert.strictEqual(state.facts.start_date, '2023-06-01');           // 影响金额的冲突不自动选
  assert.strictEqual(state.facts.monthly_wage, 9000);
  assert.strictEqual(state.facts.signed_contract, 'yes');
  assert.deepStrictEqual(out.asks.map(a => a.key), ['start_date', 'monthly_wage']);   // 交给用户选，两个值都留着
  assert.deepStrictEqual(out.asks[0].values.map(v => v.v), ['2023-06-01', '2022-06-15']);
});
test('材料识别：说过没签却传了合同，只提示不改', () => {
  const state = { facts: { signed_contract: 'no' }, manual: {}, applicant: {}, respondent: {} };
  const out = D.apply('contract', {}, state);
  assert.strictEqual(state.facts.signed_contract, 'no');
  assert.strictEqual(out.asks[0].key, 'signed_contract');
});
test('材料识别：解除通知写入离职日期和书面通知', () => {
  const state = { facts: {}, manual: {}, applicant: {}, respondent: {} };
  D.apply('termination', { end_date: '2026-10-21', termination_reason_text: '严重违纪' }, state);
  assert.strictEqual(state.facts.end_date, '2026-10-21');
  assert.strictEqual(state.facts.termination_form, 'written');
});

test('地区参数（校准文档 7.15）：二倍工资时效 整体/逐月/争议，月工资是否含加班费', () => {
  // 2025-01-10 入职未签，2026-02-01 离职，预计 2026-03-01 申请 → 切点 2025-03-01
  const f = { start_date: '2025-01-10', end_date: '2026-02-01', monthly_wage: 10000, monthly_overtime: 2000, signed_contract: 'no', filing_date: '2026-03-01' };
  const def = E.doubleWage(f, { double_wage_limitation: '有争议', overtime_in_base: '有争议' }, '2026-03-01');
  const whole = E.doubleWage(f, { double_wage_limitation: '整体', overtime_in_base: '是' }, '2026-03-01');
  const monthly = E.doubleWage(f, { double_wage_limitation: '逐月', overtime_in_base: '否' }, '2026-03-01');
  assert.strictEqual(whole.amount, def.amount);           // 整体：主张值同默认
  assert.strictEqual(whole.conservative, undefined);      // 整体 + 含加班费：没有保守值
  assert.ok(def.conservative < def.amount);               // 默认：双值
  assert.strictEqual(monthly.conservative, undefined);    // 逐月 + 不含加班费：直接是主张值
  assert.strictEqual(monthly.amount, def.conservative);   // 等于默认的保守值（扣加班费 + 逐月切）
  const c = E.compensation(f, { overtime_in_base: '否' });
  assert.strictEqual(c.base, 8000);
  assert.match(c.notes[0], /不含加班费/);
});

test('地区表：浙江/重庆整体、四川逐月且不含加班费，其余默认争议', () => {
  assert.strictEqual(G.standardsFor('杭州', '2026-10-01').double_wage_limitation, '整体');
  assert.strictEqual(G.standardsFor('重庆', '2026-10-01').double_wage_limitation, '整体');
  assert.strictEqual(G.standardsFor('成都', '2026-10-01').double_wage_limitation, '逐月');
  assert.strictEqual(G.standardsFor('成都', '2026-10-01').overtime_in_base, '否');
  assert.strictEqual(G.standardsFor('南京', '2026-10-01').double_wage_limitation, '有争议');
  assert.strictEqual(G.standardsFor('南京', '2026-10-01').application_format.triage.yes.name, '南京市劳动人事争议仲裁院');
  assert.strictEqual(G.standardsFor('广州', '2026-10-01').double_wage_limitation, '有争议');
});
