// 流程状态机与文书模板（纯代码，不经过模型）。
// 三明治架构的中间层：哪一步能进、缺什么卡在哪，都在这里写死；申请书的请求句式也在这里用变量替换。
(function (root) {
  const R = typeof module !== 'undefined' && module.exports ? require('../rules/rules.js') : root.LA.rules;

  // 参与计算的参数。由模型读出（口述或材料识别）的值，用户确认前不出金额。
  const CALC_KEYS = ['start_date', 'end_date', 'monthly_wage', 'wages_owed_amount', 'contract_signed_date', 'monthly_overtime'];
  const KEY_LABEL = { start_date: '入职日期', end_date: '离职日期', monthly_wage: '月工资', wages_owed_amount: '欠付工资', contract_signed_date: '补签合同日期', monthly_overtime: '加班费' };

  // 待确认的计算参数（pending 记录哪些事实是模型读出、用户还没确认的）
  function unconfirmed(facts, pending) {
    return CALC_KEYS.filter(k => pending[k] && facts[k] != null && facts[k] !== '');
  }

  // 每一步的解锁条件。state = { facts, pending, selected, conflicts, chosen, evidence, started }
  // 返回 { P1: {open, why: []}, ... }，why 写明卡在哪里
  function gates(state) {
    const g = {};
    const lock = (id, prev, reasons) => { const why = [...(prev && !prev.open ? ['先完成上一步'] : []), ...reasons]; g[id] = { open: !why.length, why }; };
    g.P1 = { open: true, why: [] };
    lock('P2', g.P1, state.started ? [] : ['先说说你遇到了什么']);
    lock('P3', g.P2, [
      ...(state.selected.length ? [] : ['至少勾选一项请求']),
      ...state.conflicts.map(p => `「${p[0]}」和「${p[1]}」只能二选一`),
    ]);
    const pend = unconfirmed(state.facts, state.pending);
    lock('P4', g.P3, [
      ...(pend.length ? [`先确认这些参数：${pend.map(k => KEY_LABEL[k]).join('、')}`] : []),
      ...state.chosen.filter(c => c.calc && c.calc.amount == null).map(c => `「${c.title}」还缺：${c.calc.lack.join('、')}`),
    ]);
    lock('P5', g.P4, []);
    // 申请书不因证据不足上锁（时效紧的用户不能被卡住），证据不足只在请求上标「需补证」；
    // 法定必填项（当事人、请求、事实与理由）在导出时由 requiredMissing 检查
    lock('P6', g.P5, []);
    return g;
  }

  // 申请书法定必填项（调解仲裁法第 28 条），缺了不能导出
  const REQUIRED = {
    applicant: { name: '申请人姓名', gender: '申请人性别', id_no: '申请人身份证号', address: '申请人住址', phone: '申请人电话' },
    respondent: { name: '被申请人名称', address: '被申请人住所', legal_rep: '被申请人法定代表人', legal_rep_title: '法定代表人职务' },
  };
  // 北京模板的加项：缺了标「建议填」，不锁（律师线程：北京模板作全国底版）
  const SUGGESTED = {
    applicant: { ethnicity: '民族', birth: '出生日期', hukou: '户口性质' },
    respondent: { company_type: '企业性质', office_address: '办公地或经营地', contact: '单位联系人', contact_title: '联系人部门及职务', phone: '单位联系电话' },
  };
  function suggestedMissing(app) {
    const miss = [];
    for (const role of ['applicant', 'respondent']) for (const [k, label] of Object.entries(SUGGESTED[role])) if (!String(app[role][k] || '').trim()) miss.push(label);
    return miss;
  }
  // 身份证号推出生日期和性别（纯代码）
  function fromIdNo(id) {
    const m = String(id || '').match(/^\d{6}(\d{4})(\d{2})(\d{2})\d{2}(\d)[\dXx]$/);
    if (!m) return {};
    return { birth: `${m[1]}-${m[2]}-${m[3]}`, gender: +m[4] % 2 ? '男' : '女' };
  }
  function requiredMissing(app, chosen) {
    const miss = [];
    for (const role of ['applicant', 'respondent']) for (const [k, label] of Object.entries(REQUIRED[role])) if (!String(app[role][k] || '').trim()) miss.push(label);
    if (!chosen.length) miss.push('至少一项仲裁请求');
    if (!String(app.reasons || '').trim()) miss.push('事实与理由');
    return miss;
  }

  // 申请书「仲裁请求」句式：金额只来自计算引擎
  const REQUEST_TEMPLATES = {
    illegal_termination: amt => `请求裁决被申请人支付申请人违法解除劳动合同赔偿金 ${amt} 元`,
    double_wage: amt => `请求裁决被申请人支付申请人未签订书面劳动合同二倍工资差额 ${amt} 元`,
    economic_compensation: amt => `请求裁决被申请人支付申请人解除劳动合同经济补偿金 ${amt} 元`,
    notice_pay: amt => `请求裁决被申请人支付申请人未提前三十日书面通知的代通知金（额外一个月工资） ${amt} 元`,
    unpaid_wages: amt => `请求裁决被申请人支付申请人拖欠的工资 ${amt} 元`,
    reinstatement: () => '请求裁决撤销被申请人作出的解除劳动合同决定，恢复双方劳动关系',
  };
  function requestLines(chosen, yuan) {
    return chosen.map(c => REQUEST_TEMPLATES[c.id](c.calc && c.calc.amount != null ? yuan(c.calc.amount) : '____'));
  }

  // 校验模型起草的「事实与理由」：不许出现金额；出现的日期必须是用户确认过的事实里的日期，
  // 或当事人自己写下的补充细节（userTexts）里出现过的日期
  function checkReasons(text, facts, userTexts) {
    const problems = [];
    if (/\d[\d,，.]*\s*(万)?元/.test(text || '')) problems.push('出现了金额');
    const pad = n => String(n).padStart(2, '0');
    const known = ['start_date', 'end_date', 'contract_signed_date'].map(k => facts[k]).filter(Boolean);
    for (const t of userTexts || []) for (const x of String(t).matchAll(/(\d{4})\s*[年\-./]\s*(\d{1,2})(?:\s*[月\-./]\s*(\d{1,2}))?/g))
      known.push(`${x[1]}-${pad(x[2])}` + (x[3] ? `-${pad(x[3])}` : ''));
    const ok = (y, m, d) => known.some(k => d ? k === `${y}-${pad(m)}-${pad(d)}` : k.startsWith(`${y}-${pad(m)}`));
    for (const x of (text || '').matchAll(/(\d{4})\s*[年\-./]\s*(\d{1,2})(?:\s*[月\-./]\s*(\d{1,2}))?/g)) {
      if (!ok(+x[1], +x[2], x[3] ? +x[3] : null)) problems.push(`出现了事实里没有的日期 ${x[0]}`);
    }
    return problems;
  }

  // 合并案件信息：对话、补正时补充的细节、材料识别结果、证据勾选、请求与分档，汇成一份给模型总结用的记录。
  // 只放用户确认过的事实，不放任何金额（金额只在申请书的「仲裁请求」里由代码填）。
  const MONEY_KEYS = ['monthly_wage', 'wages_owed_amount', 'monthly_overtime'];
  // 用户原话里的金额也不交给模型：「月薪9000」「欠了两万块」→「月薪[金额略]」
  function redactMoney(t) {
    return t
      .replace(/(月薪|工资|底薪|薪水|欠|赔偿?|补偿|发了|给了)\s*(大概|大约|约|是|了|我)?\s*[\d一二三四五六七八九十两百千万,.]+\s*(万|千|k|K)?\s*(元|块钱?)?/g, '$1[金额略]')
      .replace(/[\d,.]+\s*(万|千)?\s*(元|块钱?)/g, '[金额略]');
  }
  function buildRecord(c) {
    const pending = c.pending || {};
    const facts = Object.fromEntries(Object.entries(c.facts || {}).filter(([k, v]) => !pending[k] && !MONEY_KEYS.includes(k) && v != null && v !== ''));
    const words = [
      // 回答金额类追问的那句（例如只答了「9000」）整句不放
      ...(c.chat || []).filter((m, i, all) => m.role === 'user' && !(all[i - 1] && all[i - 1].type === 'number')).map(m => m.text),
      ...(c.supplements || []).map(s => s.text),
    ].map(t => redactMoney(String(t || '').trim())).filter(Boolean);
    return {
      confirmed_facts: facts,
      user_words: words,
      materials: (c.recognized || []).filter(r => !r.busy).map(r => ({ name: r.tag, read: r.filled, note: r.note && !/元/.test(r.note) ? r.note : undefined })),
      evidence: Object.values(c.evidence || {}).flat(),
      claims: (c.chosen || []).map(x => ({ title: x.title, tier: x.tier, disputes: x.disputes || [] })),
    };
  }

  const api = { CALC_KEYS, unconfirmed, gates, REQUIRED, requiredMissing, requestLines, checkReasons, buildRecord, redactMoney, SUGGESTED, suggestedMissing, fromIdNo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LA = Object.assign(root.LA || {}, { flow: api });
})(this);
