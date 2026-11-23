// 信息链的写入口：材料照片（Claude 读出字段）和对话里提到的当事人信息，都经这里写进同一份案件数据
// （事实 facts、申请人 applicant、被申请人 respondent），并在 sources 里记下每一项的来源。
// 写入规则：用户手动改过的不覆盖；申请书里已填的不覆盖；和用户说过的事实矛盾的不改，只提示。
(function (root) {
  // 每类材料要读的字段
  const KINDS = {
    contract: { title: '劳动合同', fields: ['company_name', 'company_address', 'legal_rep', 'credit_code', 'applicant_name', 'applicant_id_no', 'applicant_address', 'applicant_phone', 'start_date', 'monthly_wage'] },
    id_card: { title: '身份证', fields: ['applicant_name', 'applicant_gender', 'applicant_ethnicity', 'applicant_id_no', 'applicant_address'] },
    license: { title: '营业执照', fields: ['company_name', 'company_type', 'company_address', 'legal_rep', 'credit_code'] },
    termination: { title: '解除通知', fields: ['company_name', 'end_date', 'termination_reason_text'] },
    wage: { title: '工资记录', fields: ['company_name', 'months', 'applicant_name'] },
    social: { title: '社保记录', fields: ['company_name', 'applicant_name', 'applicant_id_no', 'start_date'] },
    other: { title: '材料', fields: ['company_name', 'applicant_name'] },
  };
  // 用户在第一轮对话里一股脑传上来的材料：先让模型判断是哪类，再按那一类读字段
  const AUTO_FIELDS = [...new Set(Object.values(KINDS).flatMap(k => k.fields))];

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
    applicant_name: '劳动者姓名', applicant_gender: '劳动者性别（男/女）', applicant_id_no: '劳动者身份证号', applicant_address: '劳动者住址', applicant_ethnicity: '民族（如 汉）', company_type: '企业类型（营业执照上的「类型」，如 有限责任公司）', applicant_phone: '劳动者联系电话',
    start_date: '入职或合同起始日期 YYYY-MM-DD', end_date: '解除或离职日期 YYYY-MM-DD', monthly_wage: '月工资（数字，元，税前应发）',
    months: '逐月工资，数组 [{"month":"YYYY-MM","gross":应发数字,"net":实发数字}]；只列照片上看得到的月份，看不清的数字不要写',
    termination_reason_text: '单位写明的解除理由（原文摘录，30 字以内）',
  };

  function prompt(kind, tag, tagOptions) {
    if (kind === 'auto') return `这是一位劳动者为劳动仲裁上传的材料照片，类型未知。先判断它是什么，再只读照片上写着的内容提取字段；看不清、没有写的不要输出，不要猜。
kind：contract（劳动合同或录用通知）|id_card（身份证）|license（营业执照）|termination（解除通知、离职证明）|wage（工资条、工资流水、个税记录）|social（社保缴费记录）|other（聊天截图、考勤、工牌等其他）
tag：从这个清单里选最贴切的一项，没有合适的输出空字符串：${(tagOptions || []).join('、')}
字段：
${AUTO_FIELDS.map(f => `${f}: ${FIELD_DESC[f]}`).join('\n')}
另外输出 summary：一句话说这张材料能看出什么事实（不写金额，30 字以内）。
另外输出 doc_date：材料上能看出的日期（聊天记录取消息日期，通知取落款日期，合同取签订日期），格式 YYYY-MM-DD 或 YYYY-MM，看不出就不输出。
只输出 JSON，例如 {"kind": "contract", "tag": "劳动合同", "company_name": "..."}`;
    const k = KINDS[kind];
    return `这是一位劳动者为劳动仲裁上传的「${tag || k.title}」照片。请只读照片上写着的内容，提取下面的字段；看不清、没有写的字段不要输出，不要猜。
字段：
${k.fields.map(f => `${f}: ${FIELD_DESC[f]}`).join('\n')}
另外输出 doc_ok：照片是否确实是「${tag || k.title}」（true/false）。
另外输出 summary：一句话说这张材料能看出什么事实（不写金额，30 字以内）；doc_date：材料上能看出的日期，格式 YYYY-MM-DD 或 YYYY-MM，看不出就不输出。
只输出 JSON，例如 {"doc_ok": true, "company_name": "..."}`;
  }

  // 月工资（经济补偿基数）= 最近 12 个月应发工资的平均数。模型只抄每月应发/实发，平均数由这里算
  function averageGross(months) {
    const n = x => +String(x == null ? '' : x).replace(/[,，元\s]/g, '');
    const ok = (Array.isArray(months) ? months : []).filter(m => m && /^\d{4}-\d{2}$/.test(m.month) && n(m.gross) > 0);
    const last = [...new Map(ok.map(m => [m.month, n(m.gross)])).entries()].sort((a, b) => b[0] < a[0] ? -1 : 1).slice(0, 12);
    if (!last.length) return null;
    return { value: Math.round(last.reduce((s, m) => s + m[1], 0) / last.length * 100) / 100, months: last.length, from: last[last.length - 1][0], to: last[0][0] };
  }

  // 把识别结果写进案件。state = { facts, manual, applicant, respondent }，原地修改，返回写了什么、哪些有矛盾。
  // 同一字段多个来源时取哪个（产品报告第 1 节「信息链」）：用户确认或手改 > 官方证照 > 其他材料 > 对话 > 推断。
  // 没记来源的已有值按用户填的处理，不覆盖。
  const OFFICIAL = ['id_card', 'license'];
  function rank(source) {
    if (!source) return 5;
    if (/你改的|你确认的/.test(source)) return 5;
    if (/^(身份证|营业执照)/.test(source)) return 4;
    if (/照片$/.test(source)) return 3;
    if (/对话|你补充的|你选的/.test(source)) return 2;
    return 1;
  }
  // 会影响请求成立或金额的事实：来源之间不一致时不自动选，交给用户（asks），两个值都留档
  const DECISIVE = ['start_date', 'end_date', 'monthly_wage', 'signed_contract', 'termination_form'];

  // source：来源说明，如「劳动合同照片」「你在对话里说的」；state.sources 记录每个字段的来源
  // （facts 用字段名，当事人用 applicant.name 这类路径）。返回写了什么（filled、wrote）、要问用户的冲突（asks）。
  function apply(kind, data, state, source) {
    const sources = state.sources || {};
    const src = (path) => { if (state.sources && source) state.sources[path] = source; };
    const newRank = rank(source || (OFFICIAL.includes(kind) ? KINDS[kind].title : '材料照片'));
    const filled = [], conflicts = [], asks = [], wrote = [];
    const label = { company_name: '公司名称', company_address: '公司住所', legal_rep: '法定代表人', credit_code: '统一社会信用代码', applicant_name: '姓名', applicant_gender: '性别', applicant_id_no: '身份证号', applicant_address: '住址', applicant_phone: '电话', applicant_ethnicity: '民族', company_type: '企业性质', start_date: '入职日期', end_date: '离职日期', monthly_wage: '月工资', signed_contract: '是否签劳动合同', termination_form: '辞退方式' };
    // 当事人信息：不影响结论，按优先级自动取值并标来源
    const put = (obj, key, field, v) => {
      if (!v) return;
      const path = (obj === state.applicant ? 'applicant.' : 'respondent.') + key;
      if (!obj[key] || (obj[key] !== v && newRank > rank(sources[path]))) { obj[key] = v; filled.push(label[field] || field); src(path); }
    };
    const fact = (key, v, shown) => {
      if (v == null || v === '') return;
      const old = state.facts[key];
      if (old == null || old === '') { if (state.manual[key]) return; state.facts[key] = v; filled.push(shown || label[key] || key); wrote.push(key); src(key); return; }
      if (old === v) return;
      if (DECISIVE.includes(key)) {
        asks.push({ key, label: label[key] || key, values: [{ v: old, source: sources[key] || '你之前说的' }, { v, source: source || '材料' }] });
        conflicts.push(`${label[key]}和之前的不一致，请选以哪个为准`);
      } else if (!state.manual[key] && newRank > rank(sources[key])) { state.facts[key] = v; filled.push(label[key] || key); src(key); }
    };
    const d = data || {};
    const date = s => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? s : null;
    const num = s => { const n = +String(s == null ? '' : s).replace(/[,，元\s]/g, ''); return n > 0 ? n : null; };
    put(state.respondent, 'name', 'company_name', d.company_name);
    put(state.respondent, 'address', 'company_address', d.company_address);
    put(state.respondent, 'legal_rep', 'legal_rep', d.legal_rep);
    put(state.respondent, 'credit_code', 'credit_code', d.credit_code);
    put(state.respondent, 'company_type', 'company_type', d.company_type);
    put(state.applicant, 'ethnicity', 'applicant_ethnicity', d.applicant_ethnicity);
    put(state.applicant, 'name', 'applicant_name', d.applicant_name);
    put(state.applicant, 'gender', 'applicant_gender', ['男', '女'].includes(d.applicant_gender) ? d.applicant_gender : null);
    put(state.applicant, 'id_no', 'applicant_id_no', d.applicant_id_no);
    put(state.applicant, 'address', 'applicant_address', d.applicant_address);
    put(state.applicant, 'phone', 'applicant_phone', d.applicant_phone);
    fact('company_name', d.company_name);
    fact('start_date', date(d.start_date));
    fact('end_date', date(d.end_date));
    const avg = kind === 'wage' ? averageGross(d.months) : null;
    fact('monthly_wage', avg ? avg.value : num(d.monthly_wage));
    if (kind === 'contract') fact('signed_contract', 'yes', '已签劳动合同');
    if (kind === 'termination') fact('termination_form', 'written', '辞退方式：书面通知');
    return { filled: [...new Set(filled)], conflicts, asks, wrote, reason: d.termination_reason_text || null, wage: avg };
  }

  // 用户在对话里说过的材料，到证据页直接勾上（只是事实到证据标签的对应，不做法律判断）
  const FACT_EVIDENCE = {
    labor_proof: { social: ['labor_relation', '社保缴费记录'], payroll: ['labor_relation', '工资银行流水（单位付款）'], badge: ['labor_relation', '工牌或工服'], chat: ['labor_relation', '工作群聊天记录'] },
    termination_form: { written: ['termination', '解除通知书'], chat: ['termination', '辞退聊天记录'] },
    signed_contract: { yes: ['labor_relation', '劳动合同'], later: ['labor_relation', '劳动合同'] },
  };
  function impliedEvidence(facts) {
    return Object.entries(FACT_EVIDENCE).map(([k, m]) => m[facts[k]]).filter(Boolean);
  }

  const api = { AUTO_FIELDS, KINDS, TAG_KIND, kindOfTag, prompt, apply, averageGross, impliedEvidence, rank, DECISIVE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LA = Object.assign(root.LA || {}, { docs: api });
})(this);
