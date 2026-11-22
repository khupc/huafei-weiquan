// 材料识别：用户在证据页或申请书页上传照片，Claude 读出字段，这里决定写到哪里。
// 写入规则：用户手动改过的不覆盖；申请书里已填的不覆盖；和用户说过的事实矛盾的不改，只提示。
(function (root) {
  // 每类材料要读的字段
  const KINDS = {
    contract: { title: '劳动合同', fields: ['company_name', 'company_address', 'legal_rep', 'credit_code', 'applicant_name', 'applicant_id_no', 'applicant_address', 'start_date', 'monthly_wage'] },
    id_card: { title: '身份证', fields: ['applicant_name', 'applicant_gender', 'applicant_id_no', 'applicant_address'] },
    license: { title: '营业执照', fields: ['company_name', 'company_address', 'legal_rep', 'credit_code'] },
    termination: { title: '解除通知', fields: ['company_name', 'end_date', 'termination_reason_text'] },
    wage: { title: '工资记录', fields: ['company_name', 'monthly_wage', 'applicant_name'] },
    social: { title: '社保记录', fields: ['company_name', 'applicant_name', 'applicant_id_no', 'start_date'] },
    other: { title: '材料', fields: ['company_name', 'applicant_name'] },
  };

  // 证据标签 → 材料类型
  const TAG_KIND = {
    劳动合同: 'contract', 录用通知: 'contract', '合同或录用通知上的薪资': 'contract',
    解除通知书: 'termination', 离职证明: 'termination',
    工资条: 'wage', 银行流水: 'wage', '工资银行流水（单位付款）': 'wage', '个税 App 收入纪录': 'wage',
    社保缴费记录: 'social',
  };
  function kindOfTag(tag) { return TAG_KIND[tag] || 'other'; }

  const FIELD_DESC = {
    company_name: '用人单位全称', company_address: '用人单位住所/地址', legal_rep: '法定代表人姓名', credit_code: '统一社会信用代码（18 位）',
    applicant_name: '劳动者姓名', applicant_gender: '劳动者性别（男/女）', applicant_id_no: '劳动者身份证号', applicant_address: '劳动者住址',
    start_date: '入职或合同起始日期 YYYY-MM-DD', end_date: '解除或离职日期 YYYY-MM-DD', monthly_wage: '月工资（数字，元，税前应发）',
    termination_reason_text: '单位写明的解除理由（原文摘录，30 字以内）',
  };

  function prompt(kind, tag) {
    const k = KINDS[kind];
    return `这是一位劳动者为劳动仲裁上传的「${tag || k.title}」照片。请只读照片上写着的内容，提取下面的字段；看不清、没有写的字段不要输出，不要猜。
字段：
${k.fields.map(f => `${f}: ${FIELD_DESC[f]}`).join('\n')}
另外输出 doc_ok：照片是否确实是「${tag || k.title}」（true/false）。
只输出 JSON，例如 {"doc_ok": true, "company_name": "..."}`;
  }

  // 把识别结果写进案件。state = { facts, manual, applicant, respondent }，原地修改，返回写了什么、哪些有矛盾。
  function apply(kind, data, state) {
    const filled = [], conflicts = [];
    const label = { company_name: '公司名称', company_address: '公司住所', legal_rep: '法定代表人', credit_code: '统一社会信用代码', applicant_name: '姓名', applicant_gender: '性别', applicant_id_no: '身份证号', applicant_address: '住址', start_date: '入职日期', end_date: '离职日期', monthly_wage: '月工资' };
    const put = (obj, key, field, v) => { if (v && !obj[key]) { obj[key] = v; filled.push(label[field] || field); } };
    const fact = (key, v, overwrite) => {
      if (v == null || v === '' || state.manual[key]) return;
      if (state.facts[key] == null || state.facts[key] === '') { state.facts[key] = v; filled.push(label[key] || key); }
      else if (state.facts[key] !== v) {
        if (overwrite) { conflicts.push(`${label[key]}：你说的是 ${state.facts[key]}，材料上是 ${v}，已按材料更新`); state.facts[key] = v; }
        else conflicts.push(`${label[key]}：你说的是 ${state.facts[key]}，材料上是 ${v}，请核对`);
      }
    };
    const d = data || {};
    const date = s => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? s : null;
    const num = s => { const n = +String(s == null ? '' : s).replace(/[,，元\s]/g, ''); return n > 0 ? n : null; };
    put(state.respondent, 'name', 'company_name', d.company_name);
    put(state.respondent, 'address', 'company_address', d.company_address);
    put(state.respondent, 'legal_rep', 'legal_rep', d.legal_rep);
    put(state.respondent, 'credit_code', 'credit_code', d.credit_code);
    put(state.applicant, 'name', 'applicant_name', d.applicant_name);
    put(state.applicant, 'gender', 'applicant_gender', ['男', '女'].includes(d.applicant_gender) ? d.applicant_gender : null);
    put(state.applicant, 'id_no', 'applicant_id_no', d.applicant_id_no);
    put(state.applicant, 'address', 'applicant_address', d.applicant_address);
    fact('company_name', d.company_name, false);
    // 书面材料上的日期比口头回忆可靠：合同、社保上的入职日期，解除通知上的离职日期，直接更新并提示
    fact('start_date', date(d.start_date), kind === 'contract' || kind === 'social');
    fact('end_date', date(d.end_date), kind === 'termination');
    fact('monthly_wage', num(d.monthly_wage), false);
    if (kind === 'contract') {
      if (!state.facts.signed_contract && !state.manual.signed_contract) { state.facts.signed_contract = 'yes'; filled.push('已签劳动合同'); }
      else if (state.facts.signed_contract === 'no') conflicts.push('你上传了劳动合同，但之前说没签过，请在事实摘要里确认（签过的话就不能主张二倍工资）');
    }
    if (kind === 'termination' && !state.facts.termination_form && !state.manual.termination_form) { state.facts.termination_form = 'written'; filled.push('辞退方式：书面通知'); }
    return { filled: [...new Set(filled)], conflicts, reason: d.termination_reason_text || null };
  }

  const api = { KINDS, TAG_KIND, kindOfTag, prompt, apply };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LA = Object.assign(root.LA || {}, { docs: api });
})(this);
