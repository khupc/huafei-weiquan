// 规则配置：法条库、计算参数、请求目录、分档条件、证据模板、抗辩模板。
// 依据《劳动仲裁法条库与计算规则校准》（律师方向线程，2026-11-22）：
//   https://claude.ai/artifact/XJREhKY3TfHcyschHTcRnk
// review 字段：'已核条号' = 校准文档已逐条核对条号；'待复核' = 条号来自常用版本、未对原文；
// '有争议' = 各地口径不一，产品同时给主张值和保守值。正式版前仍需执业律师拍板。
// L-xx 对应《劳动仲裁产品细节报告》第 3 节审校表。代码只读这份配置。
(function (root) {
  const OK = '已核条号', RECHECK = '待复核', DISPUTED = '有争议';

  // 法条库：只放条文编号和白话要点，不放原文（text 留空，等对国家法律法规数据库复核后补入）
  const LAWS = {
    'LCL-10': { name: '《劳动合同法》第10条', gist: '建立劳动关系应当订立书面劳动合同，已用工的应自用工之日起一个月内订立', review: OK },
    'LCL-14': { name: '《劳动合同法》第14条第3款', gist: '用工满一年仍未订立书面合同的，视为已订立无固定期限劳动合同', review: OK },
    'LCL-30': { name: '《劳动合同法》第30条', gist: '用人单位应当及时足额支付劳动报酬；拖欠的，劳动者可申请支付令', review: OK },
    'LCL-39-42': { name: '《劳动合同法》第39—42条', gist: '用人单位可以解除的法定情形，以及不得解除的情形', review: OK },
    'LCL-36': { name: '《劳动合同法》第36条', gist: '用人单位与劳动者协商一致，可以解除劳动合同', review: OK },
    'LCL-38': { name: '《劳动合同法》第38条', gist: '用人单位未及时足额支付劳动报酬、未依法缴纳社保等情形，劳动者可以解除劳动合同', review: OK },
    'LCL-40': { name: '《劳动合同法》第40条', gist: '医疗期满、不能胜任工作、客观情况重大变化时，提前 30 日书面通知或额外支付一个月工资后可以解除', review: OK },
    'LCL-41': { name: '《劳动合同法》第41条', gist: '经济性裁员', review: OK },
    'LCL-46': { name: '《劳动合同法》第46条', gist: '用人单位提出协商解除、依第40、41条解除、劳动者依第38条解除等情形，应当支付经济补偿', review: OK },
    'LCLR-20': { name: '《劳动合同法实施条例》第20条', gist: '额外支付的一个月工资（代通知金）按上一个月的工资标准确定', review: OK },
    'LCL-47': { name: '《劳动合同法》第47条', gist: '经济补偿按工作年限，每满一年一个月工资；月工资高于当地社平工资 3 倍的按 3 倍、年限最多 12 年', review: OK },
    'LCL-48': { name: '《劳动合同法》第48条', gist: '违法解除的，劳动者可要求继续履行；不要求或不能继续履行的，支付赔偿金', review: OK },
    'LCL-82': { name: '《劳动合同法》第82条', gist: '用工超过一个月不满一年未订立书面合同的，应向劳动者每月支付二倍工资', review: OK },
    'LCL-87': { name: '《劳动合同法》第87条', gist: '违法解除或终止的，按经济补偿标准的二倍支付赔偿金', review: OK },
    'LCLR-6': { name: '《劳动合同法实施条例》第6条', gist: '二倍工资的起止日', review: OK },
    'LCLR-7': { name: '《劳动合同法实施条例》第7条', gist: '满一年未签的，视为无固定期限，此前 11 个月付二倍工资', review: OK },
    'LCLR-25': { name: '《劳动合同法实施条例》第25条', gist: '支付赔偿金的不再支付经济补偿；赔偿金年限自用工之日起算', review: OK },
    'LCLR-27': { name: '《劳动合同法实施条例》第27条', gist: '经济补偿的月工资按应得工资计算', review: OK },
    'LDAL-6': { name: '《劳动争议调解仲裁法》第6条', gist: '与争议有关的证据属用人单位掌握的，由用人单位提供', review: OK },
    'LDAL-21': { name: '《劳动争议调解仲裁法》第21条', gist: '由劳动合同履行地或用人单位所在地的仲裁委管辖', review: OK },
    'LDAL-27': { name: '《劳动争议调解仲裁法》第27条', gist: '仲裁时效一年，可中断；劳动关系存续期间拖欠劳动报酬不受一年限制，离职后一年内提出', review: OK },
    'SPC1-44': { name: '最高法劳动争议解释（一）第44条', gist: '因开除、辞退、解除、减少报酬、计算工作年限发生的争议，由用人单位负举证责任', review: OK },
    'SPC2-6': { name: '最高法劳动争议解释（二）第6条', gist: '二倍工资按月计算，不满一个月的按实际工作日计算', review: OK },
    'SPC2-7': { name: '最高法劳动争议解释（二）第7条', gist: '单位能证明因不可抗力或劳动者故意、重大过失未签合同的，不支持二倍工资', review: OK },
    'SPC2-20': { name: '最高法劳动争议解释（二）第20条', gist: '用人单位未在仲裁阶段提出时效抗辩的，诉讼中再提一般不支持', review: OK },
    'MOHRSS-2008-3': { name: '劳社部发〔2008〕3号', gist: '月计薪天数 21.75 天', review: RECHECK },
  };

  // 计算参数
  const PARAMS = {
    compensation: {
      half_year_threshold_months: 6,   // 整年之外的零头满 6 个月计 1，不满计 0.5（L-04）
      high_income_multiple: 3,         // 月工资 > 3 倍社平才封顶（L-04）
      high_income_max_years: 12,       // 只在封顶时年限最多 12 年（L-04）
      min_wage_floor: true,            // 低于当地最低工资的按最低工资（L-04）
      review: OK,
    },
    illegal_termination: { multiplier: 2, review: OK },
    double_wage: { grace_months: 1, max_months: 11, default_monthly_workdays: 21.75, review: OK }, // D 以地区表 monthly_workdays 为准
    limitation: { years: 1, review: OK },
  };

  // 请求模块。一个案子可以同时命中多个模块，入口不分类。
  //   needs：这个模块要用到的事实（engine/facts.js 的 SLOTS），追问时各模块合并去重
  //   ruled_out_when：事实取这些值时模块不成立，它独有的事实就不再问
  // supported=false 的只识别、列出，显示「暂不支持测算，建议咨询律师」（L-18）
  const CLAIMS = {
    illegal_termination: {
      title: '违法解除劳动合同赔偿金', supported: true, laws: ['LCL-48', 'LCL-87', 'LCL-47', 'LCL-39-42', 'LCLR-25', 'SPC1-44'],
      ref: ['L-04', 'L-05', 'L-17'],
      elements: [
        { key: 'labor_relation', label: '存在劳动关系' },
        { key: 'company_terminated', label: '是公司先提出解除' },
        { key: 'no_lawful_reason', label: '公司没有合法解除理由（由公司举证）' },
      ],
      key_evidence: ['labor_relation', 'termination'],
      exclusive_with: ['reinstatement'],
      needs: ['separation', 'start_date', 'end_date', 'monthly_wage', 'termination_form', 'termination_reason', 'signed_exit_doc'],
      ruled_out_when: { separation: ['resigned', 'mutual', 'contract_expired', 'still_employed'] },
    },
    reinstatement: {
      title: '恢复劳动关系（继续履行合同）', supported: true, amount: false, laws: ['LCL-48'], ref: ['L-05'],
      elements: [
        { key: 'labor_relation', label: '存在劳动关系' },
        { key: 'company_terminated', label: '是公司先提出解除' },
      ],
      key_evidence: ['labor_relation', 'termination'],
      exclusive_with: ['illegal_termination'],
      needs: ['separation', 'termination_reason', 'signed_exit_doc'],
      ruled_out_when: { separation: ['resigned', 'mutual', 'contract_expired', 'still_employed'] },
    },
    economic_compensation: {
      title: '经济补偿（N）', supported: true, laws: ['LCL-46', 'LCL-47', 'LCL-36', 'LCL-38', 'LCL-40', 'LCL-41', 'LCLR-27'],
      ref: ['L-04', 'L-07'],
      elements: [
        { key: 'labor_relation', label: '存在劳动关系' },
        { key: 'n_basis', label: '属于应付经济补偿的情形' },
      ],
      key_evidence: ['labor_relation'],
      exclusive_with: ['illegal_termination', 'reinstatement'],
      needs: ['separation', 'mutual_initiator', 'termination_reason', 'wages_owed', 'start_date', 'end_date', 'monthly_wage'],
      ruled_out_when: { separation: ['still_employed', 'contract_expired'] },
    },
    notice_pay: {
      title: '代通知金（额外一个月工资）', supported: true, laws: ['LCL-40', 'LCLR-20'], ref: ['L-04'],
      elements: [
        { key: 'labor_relation', label: '存在劳动关系' },
        { key: 'notice_not_given', label: '按第40条解除且没有提前 30 天书面通知' },
      ],
      key_evidence: ['labor_relation', 'termination'],
      exclusive_with: ['illegal_termination', 'reinstatement'],
      needs: ['separation', 'termination_reason', 'notice_30days', 'monthly_wage'],
      ruled_out_when: { separation: ['resigned', 'mutual', 'contract_expired', 'still_employed'], termination_reason: ['none', 'misconduct', 'layoff', 'other'] },
    },
    double_wage: {
      title: '未签书面劳动合同二倍工资差额', supported: true, laws: ['LCL-10', 'LCL-82', 'LCL-14', 'LCLR-6', 'LCLR-7', 'SPC2-6', 'SPC2-7'], ref: ['L-03'],
      elements: [
        { key: 'labor_relation', label: '存在劳动关系' },
        { key: 'no_contract', label: '用工满一个月仍未签书面合同' },
      ],
      key_evidence: ['labor_relation'],
      exclusive_with: [],
      needs: ['signed_contract', 'start_date', 'end_date', 'contract_signed_date', 'monthly_wage', 'hr_role', 'refused_to_sign'],
      ruled_out_when: { signed_contract: ['yes'] },
    },
    unpaid_wages: {
      title: '拖欠工资', supported: true, laws: ['LCL-30', 'LDAL-27', 'LDAL-6'], ref: ['L-02', 'L-10'],
      elements: [
        { key: 'labor_relation', label: '存在劳动关系' },
        { key: 'wages_owed', label: '有已到期未发的工资' },
      ],
      key_evidence: ['labor_relation', 'wage'],
      exclusive_with: [],
      needs: ['wages_owed', 'wages_owed_amount'],
      ruled_out_when: { wages_owed: ['no'] },
    },
    // 以下首批只识别不测算
    overtime: { title: '加班费', supported: false, ref: ['L-08'] },
    annual_leave: { title: '未休年假工资', supported: false, ref: ['L-09'] },
    social_insurance: { title: '补缴社保', supported: false, ref: ['L-11'], note: '补缴一般不归仲裁委管，可找社保征收机构（多为税务）或劳动监察' },
  };

  // 每个案子都要的事实
  const CORE_FACTS = ['city', 'company_name'];

  // 前置条件：成立后其他请求才有意义。没签书面合同时，先要能证明存在劳动关系（L-01）
  const PREREQUISITES = {
    labor_relation: { title: '确认劳动关系', needs: ['labor_proof'], applies_unless: { signed_contract: ['yes'] } },
  };

  // 分流：程序和这里不同的，不进入下面的测算，单独提示。内容待律师方向线程校准。
  const ROUTES = {
    work_injury: {
      title: '工伤', when_issues: ['work_injury'],
      why: '工伤要先做工伤认定和劳动能力鉴定，赔偿主要由工伤保险基金支付，和这里的计算是两条路。申请工伤认定要提交劳动关系证明（事实劳动关系也可以），没有劳动关系材料的，要先仲裁确认劳动关系。',
      next: '本产品暂不支持工伤测算。单位应在事故发生或职业病确诊之日起 30 日内申请工伤认定；单位没申请的，你本人、近亲属或工会最迟 1 年内可以直接向用人单位所在地的社保行政部门申请，越早越好。建议同时咨询律师。',
      review: '待校准',
    },
    confirm_relation: {
      title: '先确认劳动关系', when_issues: ['platform_work'], when_facts: { labor_proof: ['none'] },
      why: '在平台接单（外卖、网约车等）、外包，或者手上没有任何能证明在这家公司上班的材料时，是否存在劳动关系、和谁存在劳动关系会是第一个争点。',
      next: '可以把「确认与某公司存在劳动关系」列为第一项仲裁请求，下面的金额都以它成立为前提。注意：请求里有确认劳动关系的，整个案子都不是一裁终局。',
      review: OK,
    },
    dispatch: {
      title: '劳务派遣', when_issues: ['dispatch'],
      why: '劳务派遣时，和你签合同的派遣公司是用人单位，你实际上班的公司是用工单位。',
      next: '申请仲裁时可以把派遣公司和用工单位列为共同被申请人。',
      review: OK,
    },
    subcontract: {
      title: '挂靠或违法转包、分包', when_issues: ['subcontract'],
      why: '包工头挂靠或违法转包、分包时，发包方或被挂靠单位要承担用工主体责任，但这不等于和它们存在劳动关系。',
      next: '这类情况的被申请人和请求怎么写比较复杂，建议咨询律师。工程建设领域欠薪还可以找总包单位。',
      review: OK,
    },
  };

  // 分档条件（校准文档 5.3）。顺序：命中 disputed_when → 有争议；缺 solid_requires → 需补证；否则基本稳。
  // 条件名在 engine/engine.js 的 DISPUTE / SOLID 里实现。
  const TIER_RULES = {
    illegal_termination: { disputed_when: ['company_claims_cause', 'reason_unknown', 'signed_exit_doc', 'pre2008_high_income', 'overtime_base_regional'], solid_requires: ['written_termination'], review: OK },
    reinstatement: { disputed_when: ['company_claims_cause', 'reason_unknown', 'signed_exit_doc'], solid_requires: [], review: OK },
    double_wage: { disputed_when: ['hr_role', 'refused_to_sign', 'double_wage_beyond_limitation', 'overtime_base_regional'], solid_requires: [], review: OK },
    unpaid_wages: { disputed_when: ['unpaid_beyond_limitation'], solid_requires: [], review: OK },
    economic_compensation: { disputed_when: ['constructive_resignation', 'pre2008_high_income', 'overtime_base_regional'], solid_requires: [], review: OK },
    notice_pay: { disputed_when: [], solid_requires: ['written_termination'], review: OK },
  };

  // 证据模板（校准文档 5.1）：分组 → 证明目的 → 备选材料
  const EVIDENCE = [
    { group: 'labor_relation', title: '劳动关系', purpose: '证明申请人与被申请人存在劳动关系及入职日期',
      options: ['劳动合同', '社保缴费记录', '工资银行流水（单位付款）', '工牌或工服', '考勤记录', '录用通知', '工作群聊天记录', '企业微信/钉钉账号', '同事证言'] },
    { group: 'wage', title: '工资数额', purpose: '证明工资标准及欠付情况',
      options: ['工资条', '银行流水', '个税 App 收入纪录', '合同或录用通知上的薪资', '谈薪聊天记录', '欠条或欠薪承诺'] },
    { group: 'termination', title: '解除事实', purpose: '证明被申请人单方解除劳动关系的时间和方式',
      options: ['解除通知书', '辞退聊天记录', '通话录音', '停用账号/门禁截图', '离职证明'] },
  ];
  const EVIDENCE_TIP = '录音和聊天记录请保留原始手机或账号，能看出对方身份，不要只存截图。';

  // 用人单位常见抗辩（校准文档 5.2）
  // 对方可能的抗辩。报告页把它们列出来，请当事人逐条回应（质证）、补充细节，再重新分析。
  // slot：这条抗辩对应的事实项，页面直接给出该项的选项让当事人点选。
  const DEFENSES = {
    illegal_termination: [
      { says: '你是自己辞职或旷工，不是我们辞退的', slot: 'termination_form', prepare: '辞退的聊天记录、录音，或被移出工作群、停用门禁的截图。这是最常见的风险点' },
      { says: '你严重违反规章制度，我们是合法解除', prepare: '规章制度是否经过民主程序并告知过你；被指违纪那件事的经过' },
      { says: '你不胜任工作', prepare: '公司是否培训或调岗后才解除；考核记录' },
      { says: '双方是协商一致解除', slot: 'signed_exit_doc', prepare: '你是否签过离职协议或任何离职文件' },
    ],
    reinstatement: [
      { says: '合同已经无法继续履行', prepare: '岗位仍在、公司仍在经营的证据；你是否已在别处工作' },
    ],
    double_wage: [
      { says: '合同签过了', slot: 'signed_contract', prepare: '是否签过任何文件，包括事后补签、倒签日期的；合同在公司手里不等于没签' },
      { says: '是你自己拒签', slot: 'refused_to_sign', prepare: '公司有没有书面通知你签合同' },
      { says: '你负责人事，签合同是你的职责', slot: 'hr_role', prepare: '你的实际职务和工作内容' },
      { says: '已经超过仲裁时效', prepare: '离职日期证明；向公司主张过权利的记录（可中断时效）' },
    ],
    unpaid_wages: [
      { says: '工资已经发过了', prepare: '银行流水，证明对应月份没有到账或少到账' },
      { says: '你的工资标准没有那么高', prepare: '工资条、录用通知、谈薪聊天记录' },
      { says: '提成或奖金没达到发放条件', prepare: '提成或奖金规则、你的业绩数据' },
    ],
  };

  // 维权路径（L-16）
  const PATH = [
    { step: '整理证据', time: '现在就可以开始', note: '按证据清单把材料拍照、截图、导出，原件保存好' },
    { step: '与公司协商，或向劳动监察投诉', time: '一般 15 天左右', note: '不是必经程序。欠薪可以先找劳动监察，事实清楚的也可向法院申请支付令' },
    { step: '向仲裁委申请仲裁', time: '仲裁委 5 日内决定是否受理', note: '劳动仲裁不收费；注意仲裁时效' },
    { step: '开庭与裁决', time: '受理之日起 45 日内结案，可延长 15 日', note: '逾期未裁的可以直接起诉。开庭带齐证据原件' },
    { step: '不服起诉或申请执行', time: '收到裁决书 15 日内起诉', note: '每项都不超过当地月最低工资 12 倍的属终局裁决，单位只能 30 日内向中级法院申请撤销' },
  ];

  const api = { OK, RECHECK, DISPUTED, LAWS, PARAMS, CLAIMS, CORE_FACTS, PREREQUISITES, ROUTES, TIER_RULES, EVIDENCE, EVIDENCE_TIP, DEFENSES, PATH };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LA = Object.assign(root.LA || {}, { rules: api });
})(this);
