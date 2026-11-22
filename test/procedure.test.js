// 行动链：能不能申请、份数、提交后时间线
const test = require('node:test');
const assert = require('node:assert');
const P = require('../engine/procedure.js');

test('工作日：跳过周末', () => {
  assert.strictEqual(P.addWorkdays('2026-11-20', 5), '2026-11-27');   // 周五 + 5 个工作日
  assert.strictEqual(P.shiftWorkdays('2026-11-30', -3), '2026-11-25'); // 周一往前 3 个工作日
});

test('能不能申请：时效临近列为风险，提示先提交', () => {
  const r = P.eligibility({ facts: { signed_contract: 'yes', separation: 'company_terminated' }, routes: [], limitation: { deadline: '2026-12-20', expired: false }, today: '2026-11-22', arbitration: '苏州市劳动人事争议仲裁委员会' });
  assert.strictEqual(r.level, 'risk');
  assert.match(r.items.find(i => i.label === '时效').note, /先提交保住时效/);
});

test('能不能申请：工伤分流，没有劳动关系材料列为风险', () => {
  assert.strictEqual(P.eligibility({ facts: {}, routes: [{ id: 'work_injury' }] }).level, 'route');
  const r = P.eligibility({ facts: { signed_contract: 'no', labor_proof: 'none' }, routes: [], limitation: { deadline: '2027-10-01', expired: false }, today: '2026-11-22' });
  assert.strictEqual(r.items.find(i => i.label === '劳动关系').status, 'risk');
});

test('份数：默认被申请人数 + 2，自留 1', () => {
  assert.deepStrictEqual(P.copies(null, 1), { submit: 3, keep: 1, note: '依据呼伦贝尔样本，待核' });
  assert.strictEqual(P.copies(null, 2).submit, 4);
  assert.strictEqual(P.materials({ copies: P.copies(null, 1), hasAgent: true }).find(m => m.id === 'power_of_attorney').count, 2);
});

test('时间线：受理 5 个工作日、裁决 45 日、终局与非终局的起诉期限', () => {
  const t = P.timeline({ submitted: '2026-11-23', accepted: '2026-11-27', hearing: '2026-12-21', awardReceived: '2027-01-15', finalAward: true });
  const by = k => t.find(e => e.key === k);
  assert.strictEqual(by('award').date, '2027-01-11');
  assert.strictEqual(by('postpone').date, '2026-12-16');
  assert.strictEqual(by('sue').date, '2027-01-30');
  assert.strictEqual(by('revoke').date, '2027-02-14');
  const t2 = P.timeline({ submitted: '2026-11-23' });
  assert.strictEqual(t2.find(e => e.key === 'accept').date, '2026-11-30');
  assert.match(P.ics(t, '案件'), /DTSTART;VALUE=DATE:20270111/);
});

test('北京区级仲裁窗口：已核 11 区有地址电话，未核的为空', () => {
  const G = require('../rules/regions.js');
  const f = G.standardsFor('北京', '2026-10-01').application_format;
  assert.strictEqual(f.districts['朝阳'].phone, '010-87983310');
  assert.strictEqual(f.districts['大兴'], null);
  assert.strictEqual(Object.values(f.districts).filter(Boolean).length, 11);
  assert.strictEqual(f.online, null);
});
