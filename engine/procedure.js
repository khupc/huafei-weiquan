// 行动链（纯代码）：能不能申请、提交材料与份数、提交后的时间线。
// 依据：律师线程校准文档第 7 节（调解仲裁法；《劳动人事争议仲裁办案规则》人社部令第 33 号；地方样本标「待核」）。
// 办案规则第 80 条：「三日、五日、十日」指工作日，「十五日、四十五日」指自然日。
(function (root) {
  const DAY = 86400000;
  const d = s => new Date(s + 'T00:00:00Z');
  const iso = t => new Date(t).toISOString().slice(0, 10);
  const addDays = (s, n) => iso(d(s).getTime() + n * DAY);
  // 法定节假日调休未计入，只跳过周六周日（页面上注明）
  function addWorkdays(s, n) {
    let t = d(s).getTime(), left = n;
    while (left > 0) { t += DAY; const w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) left--; }
    return iso(t);
  }

  // ① 能不能申请。input = { facts, routes, limitation, today, arbitration }
  // 返回 { level: 'ok' | 'risk' | 'route', items: [{ label, status: 'ok'|'risk'|'route'|'info', note }] }
  function eligibility(x) {
    const f = x.facts || {}, items = [];
    // 受案范围：工伤认定、补缴社保等不走仲裁（或要先办别的）
    const routed = (x.routes || []).filter(r => r.id === 'work_injury');
    if (routed.length) items.push({ label: '是不是劳动仲裁管的事', status: 'route', note: '工伤待遇争议一般要先有工伤认定结论：单位 30 日内申请认定，单位不申请的你本人 1 年内可以直接申请（工伤保险条例第 17 条）。其他请求仍可申请仲裁。' });
    else items.push({ label: '是不是劳动仲裁管的事', status: 'ok', note: '辞退、工资、未签合同都属于劳动仲裁受理范围（调解仲裁法第 2 条）。' });
    if ((f.other_issues || []).includes('social_insurance')) items.push({ label: '补缴社保', status: 'info', note: '要求补缴社保一般向社保经办机构或劳动监察投诉，不在仲裁里处理。' });
    // 劳动关系
    if (f.signed_contract === 'yes' || f.signed_contract === 'later') items.push({ label: '劳动关系', status: 'ok', note: '签过劳动合同，劳动关系清楚。' });
    else if (f.labor_proof === 'none') items.push({ label: '劳动关系', status: 'risk', note: '没有合同，也没有社保、工资流水等材料，要先把「确认劳动关系」作为第一项请求，整案不是一裁终局。' });
    else if (f.signed_contract === 'no') items.push({ label: '劳动关系', status: 'ok', note: '没签合同，但社保、工资流水、工牌、聊天记录等可以证明劳动关系。' });
    else items.push({ label: '劳动关系', status: 'info', note: '还没确认有没有劳动合同。' });
    // 时效
    const lim = x.limitation ? { ...x.limitation, daysLeft: x.today ? Math.round((d(x.limitation.deadline) - d(x.today)) / DAY) : null } : null;
    if (f.separation === 'still_employed') items.push({ label: '时效', status: 'ok', note: '在职期间追讨欠薪不受 1 年时效限制，离职后要在 1 年内申请（调解仲裁法第 27 条）。' });
    else if (!lim) items.push({ label: '时效', status: 'info', note: '离职日期还没确认，确认后计算。' });
    else if (lim.expired) items.push({ label: '时效', status: 'risk', daysLeft: lim.daysLeft, note: `离职已超过 1 年（截止 ${lim.deadline}）。仍可申请，但公司可能提出时效抗辩；向公司讨要过、向劳动监察投诉过的记录可以中断时效。` });
    else if (lim.daysLeft != null && lim.daysLeft <= 60) items.push({ label: '时效', status: 'risk', daysLeft: lim.daysLeft, note: `还剩 ${lim.daysLeft} 天（截止 ${lim.deadline}）。先提交保住时效，证据可以之后补。` });
    else items.push({ label: '时效', status: 'ok', note: `在 1 年时效内，截止 ${lim ? lim.deadline : ''}。` });
    // 去哪个仲裁委
    items.push({ label: '去哪个仲裁委', status: x.arbitration ? 'ok' : 'info', note: x.arbitration ? `${x.arbitration}（工作地；公司所在地的仲裁委也可以，调解仲裁法第 21 条）。区县级还是市级受理各地分工不同，待核。` : '工作城市还没确认。' });
    // 公司是否还存在：H5 查不了工商，指引用户自查
    items.push({ label: '公司还在不在', status: 'info', note: '提交前到「国家企业信用信息公示系统」（www.gsxt.gov.cn）按公司名查一下：写申请书要用工商登记的全称，公司已注销或吊销的要另作处理。' });
    const level = items.some(i => i.status === 'route') ? 'route' : items.some(i => i.status === 'risk') ? 'risk' : 'ok';
    return { level, items };
  }

  // 份数：法定为「按被申请人人数提交副本」；实务另加仲裁委留存和自留。默认按呼伦贝尔样本（待核）：
  // 申请书、证据清单、证据复印件各「被申请人数 + 2」份交仲裁委，再自留 1 份
  function copies(rule, respondents) {
    const r = rule || {};
    const n = Math.max(1, respondents || 1);
    return { submit: n + (r.plus != null ? r.plus : 2), keep: r.keep != null ? r.keep : 1, note: r.source || '依据呼伦贝尔样本，待核' };
  }

  // 提交包材料清单。input = { copies, hasAgent, evidenceCount, evidencePages }
  function materials(x) {
    const c = x.copies;
    const list = [
      { id: 'application', name: '劳动人事争议仲裁申请书', prepare: '已生成，签名处签名', count: c.submit, keep: c.keep, sign: '末页「申请人」处签名并写日期', legal: '法定' },
      { id: 'evidence_list', name: '证据清单', prepare: '已生成', count: c.submit, keep: c.keep, sign: '末页「提交人」处签名', legal: '实务普遍要求' },
      { id: 'evidence_copies', name: `证据复印件（${x.evidenceCount || 0} 项${x.evidencePages ? '，约 ' + x.evidencePages + ' 页' : ''}）`, prepare: '按证据清单顺序排好，每页右下角写页码；原件自己留着开庭带', count: c.submit, keep: 0, sign: '', legal: '实务要求' },
      { id: 'id_copy', name: '申请人身份证复印件（正反面印在一页）', prepare: '证据页上传的身份证照片打印', count: 1, keep: 0, sign: '', legal: '实务要求，部分地方要带原件' },
      { id: 'company_info', name: '被申请人企业登记信息', prepare: '到国家企业信用信息公示系统查公司，打印「基础信息」页', count: 1, keep: 0, sign: '', legal: '实务要求' },
      { id: 'service_address', name: '送达地址确认书', prepare: '已按你的地址和电话预填', count: 1, keep: 0, sign: '签名并写日期', legal: '实务要求' },
    ];
    if (x.hasAgent) list.push({ id: 'power_of_attorney', name: '授权委托书', prepare: '已生成；律师代理还要律所公函', count: 2, keep: 0, sign: '委托人签名', legal: '委托代理时需要' });
    return list;
  }

  // 出门前（或上传前）自查清单
  function checklist(x) {
    const items = [
      '申请书签名了，日期写了',
      `申请书、证据清单、证据复印件各 ${x.copies.submit} 份`,
      '证据复印件按清单顺序排好、写了页码',
      '身份证原件和复印件都带上',
      '企业登记信息打印页',
      '送达地址确认书签好名',
      '证据原件自己留好（开庭要带），不要交给仲裁委',
    ];
    if (x.hasRecording) items.push('录音证据：刻录光盘或存 U 盘，并附文字稿');
    if (x.hasAgent) items.push('授权委托书 2 份（代理人身份证复印件）');
    items.push('到窗口后索要收件回执，拍照留存');
    return items;
  }

  // 提交后的时间线。s = { submitted, accepted, evidenceDeadline, hearing, awardReceived, finalAward }
  function timeline(s) {
    const out = [];
    if (!s || !s.submitted) return out;
    out.push({ key: 'submitted', date: s.submitted, title: '已提交申请', note: '收好收件回执。材料不齐的，仲裁委会当场或 5 个工作日内一次性告诉你要补什么。', law: '办案规则第 29 条' });
    const acceptBy = addWorkdays(s.submitted, 5);
    out.push({ key: 'accept', date: s.accepted || acceptBy, due: !s.accepted, title: s.accepted ? '已受理' : `最晚 ${acceptBy} 前决定是否受理`, note: s.accepted ? '受理后 5 日内向公司送达申请书副本，公司 10 日内答辩。' : '收到申请 5 个工作日内决定（补正的从补齐之日起算）。不予受理或逾期未决定的，可以直接向法院起诉。', law: '调解仲裁法第 29 条；办案规则第 30、33 条' });
    if (s.evidenceDeadline) out.push({ key: 'evidence', date: s.evidenceDeadline, due: true, title: '举证期限截止', note: '在这天前补交证据；要增加或变更请求也要在这之前。', law: '办案规则第 15、44 条' });
    else if (s.accepted) out.push({ key: 'evidence', date: null, title: '举证期限', note: '以受理通知书上写的为准，收到后填进来。', law: '办案规则第 15 条' });
    if (s.hearing) {
      out.push({ key: 'postpone', date: shiftWorkdays(s.hearing, -3), due: true, title: '要申请延期开庭的最后一天', note: '确实去不了，要在开庭 3 日前申请延期。', law: '办案规则第 39 条' });
      out.push({ key: 'hearing', date: s.hearing, due: true, title: '开庭', note: '必须到庭，带齐证据原件。无正当理由不到庭的，可以按撤回申请处理，而且不能再就同一事项申请。', law: '办案规则第 38、39 条' });
    }
    if (s.accepted) {
      out.push({ key: 'award', date: addDays(s.accepted, 45), due: true, title: '裁决期限', note: `受理之日起 45 日内结案；经批准可延长不超过 15 日（最晚 ${addDays(s.accepted, 60)}）。补正、中止等期间不计入。逾期未裁决的可以向法院起诉。`, law: '调解仲裁法第 43 条' });
    }
    if (s.awardReceived) {
      out.push({ key: 'sue', date: addDays(s.awardReceived, 15), due: true, title: '不服裁决的起诉期限', note: s.finalAward ? '一裁终局：你不服的，收到裁决书 15 日内向法院起诉；公司只能在 30 日内向中级法院申请撤销。' : '非终局裁决：双方都可以在收到裁决书 15 日内向法院起诉，过期不起诉裁决生效。', law: '调解仲裁法第 47—50 条' });
      if (s.finalAward) out.push({ key: 'revoke', date: addDays(s.awardReceived, 30), title: '公司申请撤销的期限', note: '过了这天公司没申请撤销，裁决就稳了。', law: '调解仲裁法第 49 条' });
      out.push({ key: 'enforce', date: null, title: '申请强制执行', note: '裁决生效后公司不履行的，向法院申请强制执行。', law: '调解仲裁法第 51 条' });
    }
    return out;
  }
  // 往前或往后数工作日（负数往前）
  function shiftWorkdays(s, n) {
    if (n >= 0) return addWorkdays(s, n);
    let t = d(s).getTime(), left = -n;
    while (left > 0) { t -= DAY; const w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) left--; }
    return iso(t);
  }

  // 日历文件（.ics），每个有日期的节点一个全天事件
  function ics(events, title) {
    const esc = s => String(s || '').replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//labor-arbitration-demo//CN', 'CALSCALE:GREGORIAN'];
    events.filter(e => e.date).forEach((e, i) => {
      const day = e.date.replace(/-/g, '');
      lines.push('BEGIN:VEVENT', `UID:${title || 'case'}-${e.key}-${i}@demo`, `DTSTAMP:${day}T000000Z`, `DTSTART;VALUE=DATE:${day}`, `SUMMARY:${esc((title ? title + '：' : '') + e.title)}`, `DESCRIPTION:${esc(e.note)}`, 'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', `DESCRIPTION:${esc(e.title)}`, 'END:VALARM', 'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  const api = { addWorkdays, shiftWorkdays, eligibility, copies, materials, checklist, timeline, ics };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LA = Object.assign(root.LA || {}, { procedure: api });
})(this);
