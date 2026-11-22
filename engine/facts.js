// 事实清单与追问顺序（P1）。
// 选下一个问题由这里的规则决定；模型只负责从自由描述里抽取事实（见 web/llm.js）。
// 清单本身待律师校准（L-19）。
(function (root) {
  const SLOTS = {
    separation: {
      label: '离职方式', type: 'choice',
      ask: '公司是怎么让你走的？还是你现在仍在职？',
      alt: '换个问法：最后一天上班，是谁先提出不干了？公司说的，还是你自己说的？',
      options: [
        { label: '公司辞退/开除', value: 'company_terminated' },
        { label: '我自己辞职', value: 'resigned' },
        { label: '双方协商离职', value: 'mutual' },
        { label: '合同到期不续', value: 'contract_expired' },
        { label: '还在职', value: 'still_employed' },
      ],
    },
    start_date: {
      label: '入职日期', type: 'date',
      ask: '你是哪天开始在这家公司上班的？记不清具体哪天，写到月份也行。',
      alt: '换个问法：第一个月工资是哪个月发的？往前推一个月大概就是入职时间。',
    },
    end_date: {
      label: '离职日期', type: 'date', when: f => f.separation && f.separation !== 'still_employed',
      ask: '最后一天上班，或者被通知离开，是哪天？',
      alt: '换个问法：最后一次在工作群里说话或打卡，大概是哪天？',
    },
    monthly_wage: {
      label: '月工资（元）', type: 'number',
      ask: '离职前 12 个月，平均每月应发工资大概多少？奖金、提成、补贴都算进去，按扣社保个税之前的数。',
      alt: '换个问法：每月到你卡上或微信里大概多少钱？我们先按这个算，之后可以改。',
    },
    signed_contract: {
      label: '是否签书面劳动合同', type: 'choice',
      ask: '你和公司签过书面劳动合同吗？',
      alt: '换个问法：入职时有没有在一份写着工作岗位、工资、合同期限的纸上签过名？',
      options: [
        { label: '签了', value: 'yes' },
        { label: '一直没签', value: 'no' },
        { label: '入职很久后才补签', value: 'later' },
      ],
    },
    contract_signed_date: {
      label: '补签合同日期', type: 'date', when: f => f.signed_contract === 'later',
      ask: '后来补签合同是哪天？',
      alt: '大概是入职几个月后补签的？写个大概月份就行。',
    },
    termination_form: {
      label: '辞退方式', type: 'choice', when: f => f.separation === 'company_terminated',
      ask: '公司是用什么方式通知你走的？',
      alt: '换个问法：你手上有没有能看出「公司让你走」的东西，比如通知、聊天记录或录音？',
      options: [
        { label: '书面通知', value: 'written' },
        { label: '微信/短信消息', value: 'chat' },
        { label: '当面口头说', value: 'oral' },
      ],
    },
    termination_reason: {
      label: '公司给的理由', type: 'choice', when: f => f.separation === 'company_terminated',
      ask: '公司让你走的时候，说了什么理由吗？',
      alt: '换个问法：公司有没有说你犯了什么错、干不好，或者是公司裁员？',
      options: [
        { label: '没说理由', value: 'none' },
        { label: '说我违纪', value: 'misconduct' },
        { label: '说我不胜任', value: 'incompetence' },
        { label: '说是裁员/经营困难', value: 'layoff' },
        { label: '其他理由', value: 'other' },
      ],
    },
    signed_exit_doc: {
      label: '是否签过离职文件', type: 'choice', when: f => f.separation === 'company_terminated',
      ask: '离开时你有没有签过任何文件，比如离职协议、离职申请、交接单？',
      alt: '换个问法：最后几天公司有没有让你在什么纸上签字？',
      options: [
        { label: '没签过', value: 'no' },
        { label: '签了离职协议/申请', value: 'yes' },
      ],
    },
    hr_role: {
      label: '职务是否涉及人事或管理', type: 'choice', when: f => f.signed_contract === 'no' || f.signed_contract === 'later',
      ask: '你的工作是不是负责人事，或者是公司管理层？（比如负责给员工签合同）',
      alt: '换个问法：给新员工办入职、签合同是不是你的活？',
      options: [
        { label: '不是', value: 'no' },
        { label: '是', value: 'yes' },
      ],
    },
    refused_to_sign: {
      label: '公司是否书面通知签合同', type: 'choice', when: f => f.signed_contract === 'no' || f.signed_contract === 'later',
      ask: '公司有没有书面通知过你签合同，而你没签？',
      alt: '换个问法：公司有没有发过合同让你签，你当时没签？',
      options: [
        { label: '没有，公司从没提', value: 'no' },
        { label: '有，我没签', value: 'yes' },
      ],
    },
    wages_owed: {
      label: '是否拖欠工资', type: 'choice',
      ask: '公司有没有欠你还没发的工资？',
      alt: '换个问法：最近几个月的工资都按时足额到账了吗？',
      options: [
        { label: '有欠', value: 'yes' },
        { label: '没有欠', value: 'no' },
      ],
    },
    wages_owed_amount: {
      label: '欠付工资合计（元）', type: 'number', when: f => f.wages_owed === 'yes',
      ask: '一共欠了多少钱？按每个月税前应发减去实际到手的差额加起来。',
      alt: '换个问法：欠了几个月？每月大概少发多少？我们帮你乘一下。',
    },
    company_name: {
      label: '公司全称', type: 'text',
      ask: '公司全称是什么？可以对照营业执照、工资转账备注或社保记录。',
      alt: '不知道全称也没关系，先写你知道的名字，申请书那一步可以再查。',
    },
  };

  const ORDER = ['separation', 'start_date', 'end_date', 'monthly_wage', 'signed_contract', 'contract_signed_date',
    'termination_form', 'termination_reason', 'signed_exit_doc', 'hr_role', 'refused_to_sign', 'wages_owed', 'wages_owed_amount', 'company_name'];

  // 不在问答里问、在测算页填的参数
  const PARAM_SLOTS = {
    monthly_overtime: { label: '月工资里每月加班费（选填）', type: 'number' },
    company_city: { label: '公司所在城市（取社平工资用）', type: 'text' },
  };

  function isFilled(v) { return v !== undefined && v !== null && v !== ''; }

  // 下一个要问的事实。uncertain 记录用户已答「不确定」的次数：1 次换问法，2 次跳过。
  function nextSlot(facts, uncertain = {}) {
    for (const key of ORDER) {
      const s = SLOTS[key];
      if (s.when && !s.when(facts)) continue;
      if (isFilled(facts[key])) continue;
      if ((uncertain[key] || 0) >= 2) continue;
      return { key, ...s, useAlt: (uncertain[key] || 0) === 1 };
    }
    return null;
  }

  function progress(facts) {
    const active = ORDER.filter(k => !SLOTS[k].when || SLOTS[k].when(facts));
    return { done: active.filter(k => isFilled(facts[k])).length, total: active.length };
  }

  // ---- 没有模型时的关键词抽取（兜底） ----
  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(y, m, d) { return `${y}-${pad(m)}-${pad(d || 1)}`; }
  function addMonths(isoDate, months) {
    const d = new Date(isoDate + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + months);
    return d.toISOString().slice(0, 10);
  }
  function cnNum(s) {
    if (/^\d+$/.test(s)) return +s;
    const map = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 };
    if (s === '十') return 10;
    if (s.length === 2 && s[0] === '十') return 10 + map[s[1]];
    if (s.length === 2 && s[1] === '十') return map[s[0]] * 10;
    if (s.length === 3 && s[1] === '十') return map[s[0]] * 10 + map[s[2]];
    return map[s] != null ? map[s] : NaN;
  }

  function keywordExtract(text, today) {
    const t = text.replace(/\s+/g, '');
    const out = {};
    const issues = [];
    const N = '(\\d+|[一二两三四五六七八九十半]+)';

    const wage = t.match(/(?:月薪|工资|月工资|每月|一个月)[^\d]{0,4}(\d+(?:\.\d+)?)(万|千|k|K)?/);
    if (wage) {
      let v = parseFloat(wage[1]);
      if (wage[2] === '万') v *= 10000; else if (wage[2] === '千' || /k/i.test(wage[2] || '')) v *= 1000;
      out.monthly_wage = v;
    }

    if (/辞退|开除|炒了|别来了|不用来了|解雇|被裁|让我走|劝退/.test(t)) out.separation = 'company_terminated';
    else if (/我辞职|自己辞职|主动离职|提了离职/.test(t)) out.separation = 'resigned';
    else if (/协商离职|协商一致/.test(t)) out.separation = 'mutual';
    else if (/还在职|仍在职|现在还在/.test(t)) out.separation = 'still_employed';

    if (out.separation === 'company_terminated') {
      if (/口头|当面|电话/.test(t)) out.termination_form = 'oral';
      else if (/微信|短信|消息/.test(t) && /通知|说/.test(t)) out.termination_form = 'chat';
      else if (/书面|通知书|解除通知/.test(t)) out.termination_form = 'written';
      if (/没.{0,2}理由|无理由|没说为什么/.test(t)) out.termination_reason = 'none';
      else if (/违纪|违反.*制度/.test(t)) out.termination_reason = 'misconduct';
      else if (/不胜任|业绩不达标/.test(t)) out.termination_reason = 'incompetence';
      else if (/裁员|经营困难/.test(t)) out.termination_reason = 'layoff';
    }

    if (/没签.{0,3}合同|没有.{0,2}合同|未签.{0,3}合同|没订.{0,3}合同/.test(t)) out.signed_contract = 'no';
    else if (/补签/.test(t)) out.signed_contract = 'later';
    else if (/签了.{0,3}合同|签过.{0,3}合同|有劳动合同/.test(t)) out.signed_contract = 'yes';

    if (/欠.{0,4}工资|拖欠|没发工资|工资没发|欠薪/.test(t)) {
      out.wages_owed = 'yes';
      const owed = t.match(/欠[^\d]{0,6}(\d+(?:\.\d+)?)(万)?/);
      if (owed) out.wages_owed_amount = parseFloat(owed[1]) * (owed[2] ? 10000 : 1);
    }

    // 日期
    const dates = [...t.matchAll(/(\d{4})[年\-./](\d{1,2})(?:[月\-./](\d{1,2})日?)?/g)].map(m => iso(+m[1], +m[2], m[3] ? +m[3] : 1));
    if (/入职/.test(t) && dates[0]) out.start_date = dates[0];
    if (dates.length >= 2) { out.start_date = out.start_date || dates[0]; out.end_date = dates[1]; }

    const ref = today || new Date().toISOString().slice(0, 10);
    if (!out.end_date && out.separation && out.separation !== 'still_employed') {
      if (/上个月|上月/.test(t)) out.end_date = addMonths(ref, -1).slice(0, 8) + '01';
      else if (/今天|昨天|这周|本周|刚刚/.test(t)) out.end_date = ref;
    }
    const dur = t.match(new RegExp(`(?:做了|干了|工作了|上了)${N}年(?:${N}个?月)?`)) || t.match(new RegExp(`(?:做了|干了|工作了)${N}个月`));
    if (dur && !out.start_date) {
      const isYear = dur[0].includes('年');
      const months = isYear ? Math.round(cnNum(dur[1]) * 12 + (dur[2] ? cnNum(dur[2]) : 0)) : cnNum(dur[1]);
      const end = out.end_date || ref;
      if (!isNaN(months)) out.start_date = addMonths(end, -months);
    }

    if (/加班/.test(t)) issues.push('overtime');
    if (/年假/.test(t)) issues.push('annual_leave');
    if (/社保|五险/.test(t)) issues.push('social_insurance');
    if (issues.length) out.other_issues = issues;

    const company = t.match(/([一-龥]{2,30}(?:有限责任公司|股份有限公司|有限公司|集团))/);
    if (company) out.company_name = company[1];
    return out;
  }

  const api = { SLOTS, PARAM_SLOTS, ORDER, nextSlot, progress, keywordExtract, addMonths, isFilled };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LA = Object.assign(root.LA || {}, { facts: api });
})(this);
