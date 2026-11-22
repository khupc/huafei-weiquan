// 计算引擎与法律分析（P2、P3、P4）。
// 纯函数：输入事实、地区标准、证据勾选，输出请求卡片、金额（主张值 / 保守值）、公式和分档。模型不参与。
// 规则依据见 rules/rules.js 顶部的校准文档。
(function (root) {
  const R = typeof module !== 'undefined' && module.exports ? require('../rules/rules.js') : root.LA.rules;

  const DAY = 86400000;
  function d(s) { return new Date(s + 'T00:00:00Z'); }
  function iso(x) { return x.toISOString().slice(0, 10); }
  function addMonths(s, n) { const x = d(s); x.setUTCMonth(x.getUTCMonth() + n); return iso(x); }
  function addDays(s, n) { return iso(new Date(d(s).getTime() + n * DAY)); }
  function minDate(...xs) { return xs.filter(Boolean).sort()[0]; }
  function maxDate(...xs) { return xs.filter(Boolean).sort().pop(); }
  function yuan(n) { return (+n).toLocaleString('zh-CN', { maximumFractionDigits: 2 }); }
  function round2(n) { return Math.round(n * 100) / 100; }

  // 两个日期之间的月数：整月 + 不足一月按天数折算（只用于工作年限）
  function monthsBetween(a, b) {
    if (!a || !b || b <= a) return 0;
    let m = 0;
    while (addMonths(a, m + 1) <= b) m++;
    const from = addMonths(a, m), to = addMonths(a, m + 1);
    return m + (d(b) - d(from)) / (d(to) - d(from));
  }

  // 周一到周五的天数，含首尾。未扣法定节假日（测试版简化）。
  function workdays(from, to) {
    let n = 0;
    for (let t = d(from).getTime(); t <= d(to).getTime(); t += DAY) { const w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) n++; }
    return n;
  }

  // 工作年限 Y（L-04）：自用工之日起到解除之日；每满一年计 1；零头满 6 个月计 1，不满计 0.5
  function serviceYears(start, end) {
    const P = R.PARAMS.compensation;
    const months = monthsBetween(start, end);
    const full = Math.floor(months / 12 + 1e-9);
    const rem = months - full * 12;
    let n = full;
    if (rem >= P.half_year_threshold_months - 1e-9) n += 1;
    else if (rem > 1e-9) n += 0.5;
    return { months, n };
  }

  function missing(facts, keys) {
    const labels = { start_date: '入职日期', end_date: '离职日期', monthly_wage: '月工资', wages_owed_amount: '欠付金额' };
    return keys.filter(k => facts[k] == null || facts[k] === '').map(k => labels[k] || k);
  }

  // 保守口径的月工资：扣掉加班费（各地是否计入基数不一，L-06）
  function conservativeWage(facts, std) {
    const ot = +facts.monthly_overtime || 0;
    if (!ot || (std && std.overtime_in_base === '是')) return null;
    return Math.max(0, +facts.monthly_wage - ot);
  }

  // 经济补偿 N（违法解除赔偿金的基础）
  function compensationWith(W, facts, std) {
    const P = R.PARAMS.compensation;
    let { n } = serviceYears(facts.start_date, facts.end_date);
    let base = W;
    const notes = [];
    if (P.min_wage_floor && std && std.min_wage && base < std.min_wage) {
      base = std.min_wage;
      notes.push(`月工资低于当地最低工资，按最低工资 ${yuan(base)} 元计`);
    }
    const S = std && std.avg_wage;
    if (S) {
      const cap = S * P.high_income_multiple;
      if (base > cap) {
        base = cap;
        if (n > P.high_income_max_years) n = P.high_income_max_years;
        notes.push(`月工资高于公司所在地社平工资 ${P.high_income_multiple} 倍，按 ${yuan(cap)} 元封顶，年限最多 ${P.high_income_max_years} 年`);
      }
    } else {
      notes.push('公司所在地上年度职工月平均工资待补，未核对高收入封顶');
    }
    if (!(std && std.min_wage)) notes.push('当地最低工资待补，未核对最低工资保底');
    return { amount: round2(base * n), base, n, notes };
  }

  function compensation(facts, std) {
    const lack = missing(facts, ['start_date', 'end_date', 'monthly_wage']);
    if (!lack.length && facts.end_date <= facts.start_date) lack.push('正确的日期（离职日期早于入职日期）');
    if (lack.length) return { amount: null, lack };
    const c = compensationWith(+facts.monthly_wage, facts, std);
    return { ...c, formula: `经济补偿 ${yuan(c.base)} 元/月 × ${c.n} 个月 = ${yuan(c.amount)} 元` };
  }

  function illegalTermination(facts, std) {
    const c = compensation(facts, std);
    if (c.amount == null) return c;
    const k = R.PARAMS.illegal_termination.multiplier;
    const out = { ...c, amount: round2(c.amount * k), formula: `${c.formula}，违法解除按 ${k} 倍 = ${yuan(c.amount * k)} 元` };
    const Wc = conservativeWage(facts, std);
    if (Wc != null) {
      const cc = compensationWith(Wc, facts, std);
      out.conservative = round2(cc.amount * k);
      out.conservativeNote = `不含加班费：${yuan(cc.base)} 元/月 × ${cc.n} × ${k}`;
    }
    return out;
  }

  // 二倍工资区间（L-03）：起点 = 用工满一个月的次日；终点（含当天）= 补订前一日 / 离职日 / 满一年前一日 中最早者
  function doubleWageWindow(facts, today) {
    if (!facts.start_date) return null;
    const from = addMonths(facts.start_date, R.PARAMS.double_wage.grace_months);
    const to = minDate(
      facts.end_date || today,
      facts.signed_contract === 'later' && facts.contract_signed_date ? addDays(facts.contract_signed_date, -1) : null,
      addDays(addMonths(facts.start_date, 12), -1),
    );
    return { from, to };
  }

  // 区间内逐月计算：整月按月工资，不满一个月按 月工资 / 21.75 × 实际工作日；最多 11 个月。
  // cutoff（可选）：时效切点，按天切，跨过切点的那个月只算切点之后的工作日。
  function doubleWageAmount(from, to, W, cutoff, D) {
    const P = R.PARAMS.double_wage;
    D = D || P.default_monthly_workdays;
    let full = 0, days = 0, amount = 0;
    if (!from || !to || to < from) return { full, days, amount };
    for (let k = 0; k < P.max_months; k++) {
      const ps = addMonths(from, k);
      if (ps > to) break;
      const periodEnd = addDays(addMonths(from, k + 1), -1);
      const pe = minDate(periodEnd, to);
      const start = cutoff ? maxDate(ps, cutoff) : ps;
      if (start > pe) continue;
      if (start === ps && pe === periodEnd) { full++; amount += W; }
      else { const n = workdays(start, pe); days += n; amount += W / D * n; }
    }
    return { full, days, amount: round2(amount) };
  }

  function doubleWage(facts, std, today) {
    const lack = missing(facts, ['start_date', 'monthly_wage']);
    if (facts.signed_contract === 'later' && !facts.contract_signed_date) lack.push('补签合同日期');
    if (lack.length) return { amount: null, lack };
    const P = R.PARAMS.double_wage;
    const W = +facts.monthly_wage;
    const w = doubleWageWindow(facts, today);
    const D = (std && std.monthly_workdays) || P.default_monthly_workdays;
    const r = doubleWageAmount(w.from, w.to, W, null, D);
    const part = r.days ? ` + ${yuan(W)} ÷ ${D} × ${r.days} 个工作日` : '';
    const out = { amount: r.amount, window: w, full: r.full, days: r.days, notes: [`只算额外的那一倍（差额）；不满一个月的按 ${D} 天/月折算，工作日按周一至周五估算，调休日未计`],
      formula: `${yuan(W)} 元/月 × ${r.full} 个月${part} = ${yuan(r.amount)} 元（${w.from} 至 ${w.to}，最多 ${P.max_months} 个月）` };
    // 保守值：月工资不含加班费；时效从「预计申请仲裁日」按天倒推一年（律师线程 2026-11-22 确认）
    const cutoff = cutoffOf(facts, today);
    const Wc = conservativeWage(facts, std);
    const cut = w.from < cutoff;
    if (Wc != null || cut) {
      const c = doubleWageAmount(w.from, w.to, Wc != null ? Wc : W, cut ? cutoff : null, D);
      out.conservative = c.amount;
      out.conservativeNote = [Wc != null ? '月工资不含加班费' : '', cut ? `只算 ${cutoff} 以后的部分（从预计申请日 ${facts.filing_date || today} 倒推一年）；如果之前向公司或劳动监察主张过权利，时效可能已中断，保守值会偏低` : ''].filter(Boolean).join('；');
    }
    return out;
  }

  function unpaidWages(facts) {
    const lack = missing(facts, ['wages_owed_amount']);
    if (lack.length) return { amount: null, lack };
    const amount = round2(+facts.wages_owed_amount);
    return { amount, notes: ['按每月税前应发减实发累计；申请书里要按月列明'], formula: `按实际欠付：${yuan(amount)} 元` };
  }

  // ---------- 要件判断 ----------
  function hasEvidence(evidence, group) { return !!(evidence && evidence[group] && evidence[group].length); }

  function elementStatus(key, facts, evidence) {
    switch (key) {
      case 'labor_relation':
        // 社保、单位账户工资流水算满足；工牌、考勤算初步满足；工作群聊天单独不够（律师线程 2026-11-22）
        const ev = (evidence && evidence.labor_relation) || [];
        if (facts.signed_contract === 'yes' || facts.signed_contract === 'later' || ['social', 'payroll'].includes(facts.labor_proof)
          || ev.some(x => ['劳动合同', '社保缴费记录', '工资银行流水（单位付款）'].includes(x))) return '已满足';
        if (facts.labor_proof === 'badge' || ev.some(x => ['工牌或工服', '考勤记录', '录用通知'].includes(x))) return '初步满足';
        return '还需证据';
      case 'company_terminated':
        if (facts.separation === 'company_terminated') return '已满足';
        return !facts.separation ? '还需证据' : '不满足';
      case 'no_lawful_reason':
        return facts.termination_reason === 'none' ? '已满足' : '还需证据';
      case 'no_contract':
        if (facts.signed_contract === 'yes') return '不满足';
        if (facts.signed_contract === 'no' || facts.signed_contract === 'later') {
          const w = doubleWageWindow(facts, facts.end_date || '9999-12-31');
          if (w && w.to < w.from) return '不满足';
          return '已满足';
        }
        return '还需证据';
      case 'n_basis': {
        const t = severance(facts).type;
        if (t === 'N' || t === 'N+notice') return facts.separation === 'resigned' ? '还需证据' : '已满足';
        return t ? '不满足' : '还需证据';
      }
      case 'notice_not_given':
        if (facts.notice_30days === 'no') return '已满足';
        return facts.notice_30days === 'yes' ? '不满足' : '还需证据';
      case 'wages_owed':
        if (facts.wages_owed === 'yes') return '已满足';
        return facts.wages_owed === 'no' ? '不满足' : '还需证据';
    }
    return '还需证据';
  }

  // ---------- 争议条件（TIER_RULES.disputed_when） ----------
  // 时效切点：预计申请仲裁日（默认今天）往前一年
  function cutoffOf(facts, today) { return addMonths(facts.filing_date || today, -12 * R.PARAMS.limitation.years); }
  const DISPUTE = {
    company_claims_cause: f => ['misconduct', 'incompetence', 'layoff', 'other'].includes(f.termination_reason) && '公司给了解除理由，是否合法要看公司能否举证（规章制度是否经民主程序并告知等）',
    reason_unknown: f => !f.termination_reason && '还不清楚公司给的解除理由',
    signed_exit_doc: f => f.signed_exit_doc === 'yes' && '你签过离职文件，公司可能主张是协商一致或你主动辞职',
    pre2008_high_income: (f, t, std) => f.start_date && f.start_date < '2008-01-01' && std && std.avg_wage && +f.monthly_wage > std.avg_wage * R.PARAMS.compensation.high_income_multiple && '高收入且 2008 年前入职，2008 年前的年限是否也受 12 年限制各地不一',
    overtime_base_regional: (f, t, std) => +f.monthly_overtime > 0 && !(std && std.overtime_in_base === '是') && '月工资是否含加班费各地口径不同，已同时给出不含加班费的保守值',
    hr_role: f => f.hr_role === 'yes' && '你负责人事或属于管理层，公司可能主张未签合同是你自身的过失',
    refused_to_sign: f => f.refused_to_sign === 'yes' && '公司书面通知过签合同而你没签，可能不支持二倍工资',
    double_wage_beyond_limitation: (f, today) => {
      const w = doubleWageWindow(f, today);
      return w && w.from < cutoffOf(f, today) && '部分月份距今超过一年，二倍工资时效怎么算各地口径不同，已同时给出保守值';
    },
    constructive_resignation: f => f.separation === 'resigned' && '被迫辞职要在辞职通知里写明公司欠薪等具体理由；写「个人原因」很可能拿不到经济补偿',
    unpaid_beyond_limitation: (f, today) => f.end_date && f.end_date < cutoffOf(f, today) && '离职已超过一年，公司可能提出时效抗辩；有向公司讨薪的记录请保留（可中断时效）',
  };
  // 基本稳的额外要求（TIER_RULES.solid_requires）
  const SOLID = {
    written_termination: (f, ev) => (f.termination_form === 'written' || (ev && (ev.termination || []).includes('解除通知书'))) ? null : '补上公司书面解除通知（只有口头或聊天时，「公司先提出」容易被否认）',
  };

  function noticePay(facts) {
    const lack = missing(facts, ['monthly_wage']);
    if (lack.length) return { amount: null, lack };
    const amount = round2(+facts.monthly_wage);
    return { amount, notes: ['按上一个月的工资标准确定，这里先用月工资代替'], formula: `额外一个月工资 = ${yuan(amount)} 元` };
  }

  // 补偿判定（律师线程 2026-11-22）：2N / N / N + 代通知金 / 0。纯规则，不交给模型。
  function severance(f) {
    if (f.separation === 'company_terminated') {
      if (f.termination_reason === 'incompetence') return { type: f.notice_30days === 'yes' ? 'N' : 'N+notice', alt: '2N', why: '公司以不胜任等第40条理由解除：解除合法时付 N' + (f.notice_30days === 'yes' ? '' : '，没提前 30 天书面通知的再加一个月工资') + '；解除不合法则是 2N' };
      if (f.termination_reason === 'layoff') return { type: 'N', alt: '2N', why: '公司以经济性裁员解除：程序合法时付 N；不合法则是 2N' };
      if (f.termination_reason === 'misconduct') return { type: '2N', alt: '0', why: '公司以严重违纪解除：公司能证明合法的不付补偿；证明不了是 2N' };
      return { type: '2N', why: '公司单方解除且没有合法理由，按违法解除付 2N' };
    }
    if (f.separation === 'mutual') {
      if (f.mutual_initiator === 'company') return { type: 'N', why: '公司先提出协商解除，付 N' };
      if (f.mutual_initiator === 'employee') return { type: '0', why: '你先提出协商离职，一般没有经济补偿' };
      return { type: null, why: '还要看协商离职是谁先提的' };
    }
    if (f.separation === 'resigned') {
      if (f.wages_owed === 'yes') return { type: 'N', why: '公司欠薪时你辞职属于被迫辞职，可以要 N（辞职通知要写明理由）' };
      return { type: '0', why: '主动辞职一般没有经济补偿' };
    }
    return { type: null, why: '' };
  }

  const CALC = { illegal_termination: illegalTermination, economic_compensation: compensation, notice_pay: noticePay, double_wage: doubleWage, unpaid_wages: unpaidWages };

  // 主入口：facts + 地区标准 + 证据勾选 → 请求卡片列表
  function analyze(facts, std, evidence, today) {
    today = today || iso(new Date());
    const claims = [];
    for (const [id, def] of Object.entries(R.CLAIMS)) {
      if (!def.supported) continue;
      if (def.ruled_out_when && Object.entries(def.ruled_out_when).some(([k, vals]) => vals.includes(facts[k]))) continue;
      const elements = def.elements.map(e => ({ ...e, status: elementStatus(e.key, facts, evidence) }));
      if (elements.some(e => e.status === '不满足')) continue;
      const rule = R.TIER_RULES[id];
      const disputes = rule.disputed_when.map(k => DISPUTE[k](facts, today, std)).filter(Boolean);
      const missingEvidence = def.key_evidence.filter(g => !hasEvidence(evidence, g)).map(g => R.EVIDENCE.find(x => x.group === g).title);
      const solidGaps = rule.solid_requires.map(k => SOLID[k](facts, evidence)).filter(Boolean);
      const calc = def.amount === false ? null : CALC[id](facts, std, today);
      let tier = '基本稳';
      if (disputes.length) tier = '有争议';
      else if (missingEvidence.length || solidGaps.length || elements.some(e => e.status !== '已满足') || (calc && calc.amount == null)) tier = '需补证';
      const toSolid = [
        ...missingEvidence.map(t => `补上「${t}」类证据`),
        ...solidGaps,
        ...elements.filter(e => e.status !== '已满足').map(e => `确认：${e.label}`),
        ...(calc && calc.lack ? calc.lack.map(l => `补充${l}`) : []),
      ];
      claims.push({
        id, title: def.title, tier, elements, disputes, toSolid, calc,
        laws: def.laws.map(l => ({ id: l, ...R.LAWS[l] })), ref: def.ref,
        exclusive_with: def.exclusive_with, defenses: R.DEFENSES[id] || [],
        summary: summarize(id, facts, tier),
      });
    }
    const unsupported = detectUnsupported(facts).map(id => ({ id, title: R.CLAIMS[id].title, note: R.CLAIMS[id].note || '暂不支持测算，建议咨询律师；时效紧的先申请仲裁保住时效', ref: R.CLAIMS[id].ref }));
    return { claims, unsupported, routes: routes(facts), severance: severance(facts), limitation: limitation(facts, today) };
  }

  function summarize(id, f, tier) {
    const s = {
      illegal_termination: f.termination_reason === 'none'
        ? '公司辞退且没给理由，很可能被认定为违法解除'
        : '公司提出解除，是否违法取决于公司能否证明解除理由合法',
      reinstatement: '违法解除时也可以要求回去继续上班，并要求解除期间的工资；和赔偿金只能二选一',
      double_wage: f.signed_contract === 'later' ? '入职满一个月后才补签合同，补签前的月份可以主张二倍工资差额' : '入职满一个月仍没签书面合同，可以主张二倍工资差额',
      unpaid_wages: '已到期没发的工资，公司应当足额支付',
      economic_compensation: severance(f).why || '属于应付经济补偿的情形',
      notice_pay: '按第40条解除却没提前 30 天书面通知，要额外付一个月工资',
    }[id];
    return s + (tier === '有争议' ? '（存在争议点）' : '');
  }

  // 分流：程序不同的案子（工伤、需先确认劳动关系）
  function routes(f) {
    const issues = f.other_issues || [];
    return Object.entries(R.ROUTES).filter(([, r]) =>
      (r.when_issues || []).some(i => issues.includes(i)) ||
      Object.entries(r.when_facts || {}).some(([k, vals]) => vals.includes(f[k])),
    ).map(([id, r]) => ({ id, ...r }));
  }

  function detectUnsupported(f) {
    const ids = new Set(f.other_issues || []);
    return [...ids].filter(id => R.CLAIMS[id] && !R.CLAIMS[id].supported);
  }

  // 仲裁时效提醒（L-02）。超过一年不说「不能主张」，提示时效抗辩和中断证据。
  function limitation(f, today) {
    if (!f.end_date) return null;
    const days = Math.round((d(today) - d(f.end_date)) / DAY);
    const deadline = addMonths(f.end_date, 12 * R.PARAMS.limitation.years);
    return { days, deadline, expired: today > deadline };
  }

  // 用户勾选的请求里互斥的组合（L-05）
  function conflicts(selectedIds) {
    // 互斥是双向的：任一方声明了就算
    const ex = (a, b) => ((R.CLAIMS[a] || {}).exclusive_with || []).includes(b);
    const out = [];
    for (let i = 0; i < selectedIds.length; i++) for (let j = i + 1; j < selectedIds.length; j++) {
      const a = selectedIds[i], b = selectedIds[j];
      if (ex(a, b) || ex(b, a)) out.push([R.CLAIMS[a].title, R.CLAIMS[b].title]);
    }
    return out;
  }

  function totals(claims) {
    const t = { 基本稳: 0, 需补证: 0, 有争议: 0, conservative: 0 };
    for (const c of claims) if (c.calc && c.calc.amount) {
      t[c.tier] += c.calc.amount;
      t.conservative += c.calc.conservative != null ? c.calc.conservative : c.calc.amount;
    }
    t.total = round2(t.基本稳 + t.需补证 + t.有争议);
    t.conservative = round2(t.conservative);
    return t;
  }

  const api = { severance, monthsBetween, workdays, serviceYears, compensation, illegalTermination, doubleWage, unpaidWages, analyze, conflicts, totals, yuan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LA = Object.assign(root.LA || {}, { engine: api });
})(this);
