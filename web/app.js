// 劳动仲裁 H5 测试版：页面状态与流程（P0–P6）。
// 三明治架构：两头靠模型吞吐非标信息（口述/照片 → 结构化参数；事实与理由润色），
// 中间靠纯代码锁死确定性（金额 engine.js、流程解锁 flow.js、文书句式 flow.js）。
// 模型读出的计算参数先进 st.pending，用户确认后才出金额；模型永远不直接给用户赔偿数字。
(function () {
  const { rules: R, regions: G, facts: F, engine: E, docs: D, flow: W, procedure: P } = window.LA;
  const { createApp, reactive, computed, watch, nextTick } = Vue;
  const today = () => new Date().toISOString().slice(0, 10);

  // ---------- 模型（Claude，经 artifact 的 sample 能力；不可用时退回关键词） ----------
  const model = reactive({ status: '连接中…', ok: false });
  let samplePromise = Promise.resolve(null);
  if (window.claude && window.claude.use) samplePromise = window.claude.use('sample').catch(() => null);
  // 图片识别能力：只有 artifact 声明了 sample.images 且当前环境支持时才有
  const imgCaps = reactive({ ok: false, accept: 'image/*', max: 4 });
  samplePromise.then(async s => {
    const l = s && await s.limits().catch(() => null);
    if (l && l.images) { imgCaps.ok = true; imgCaps.accept = l.images.mediaTypes.join(','); imgCaps.max = l.images.maxCount; }
  });
  samplePromise.then(s => { model.ok = !!s; model.status = s ? 'Claude（首次调用会请你授权）' : '关键词版（当前环境用不了模型）'; });

  const SLOT_SCHEMA = `city: 工作所在城市，写地级市名（如 苏州、深圳），不带「市」
separation: company_terminated|resigned|mutual|contract_expired|still_employed
start_date / end_date / contract_signed_date: YYYY-MM-DD（只知道月份就写该月 01 日）
monthly_wage / wages_owed_amount: 数字（元）；wages_owed_amount 只在用户直接说了欠薪总数时输出
wages_owed_months / wages_owed_per_month: 用户按月说欠薪时（如「欠了 3 个月，每月 9000」）分别输出月数和每月金额，不要自己相乘
wages_owed_detail: 用户逐月说了欠多少时输出数组 [{"month":"YYYY-MM","amount":数字}]，不要自己加总
signed_contract: yes|no|later（later=入职很久后补签）
termination_form: written|chat|oral
termination_reason: none|misconduct|incompetence|layoff|other
wages_owed: yes|no
signed_exit_doc: yes|no（离开时是否签过离职协议/申请等文件）
hr_role: yes|no（职务是否负责人事或属于管理层）
refused_to_sign: yes|no（公司是否书面通知签合同而本人没签）
company_name: 字符串
labor_proof: social|payroll|badge|chat|none（没签合同时，能证明劳动关系的最有力材料：社保记录 / 单位账户发的工资流水 / 工牌工作证或考勤 / 只有工作群聊天 / 都没有）
applicant_name / applicant_gender(男|女) / applicant_phone / applicant_id_no / applicant_address: 劳动者本人的姓名、性别、电话、身份证号、住址（用户说了才输出）
company_address / legal_rep: 公司地址、法定代表人姓名（用户说了才输出）
user_claims: 数组，用户自己已经得出的主张（比如问过别的 AI 或律师），每项 {"claim": illegal_termination（违法解除赔偿金/2N）|economic_compensation（经济补偿/N）|notice_pay（代通知金/N+1 里的 1）|double_wage（未签合同二倍工资）|unpaid_wages（拖欠工资）|reinstatement（恢复劳动关系）, "amount": 用户自己说的金额数字或 null}；用户没提自己的主张就不输出
other_issues: 数组，可含 overtime|annual_leave|social_insurance|work_injury（受伤、工伤、职业病）|platform_work（外卖骑手、网约车等平台接单，或外包）|dispatch（劳务派遣）|subcontract（挂靠、包工头、违法转包分包）`;

  // evidenceOptions：补正时传入证据清单，模型顺带说出用户提到了哪些证据
  function owedDetail(arr) {
    const list = (Array.isArray(arr) ? arr : []).filter(m => m && /^\d{4}-\d{2}$/.test(m.month) && +String(m.amount).replace(/[,，元]/g, '') > 0).map(m => ({ month: m.month, amount: +String(m.amount).replace(/[,，元]/g, '') }));
    return list.length ? { wages_owed_detail: list } : {};
  }
  // 用户自己带来的结论：只记下来，金额由代码重算后对照
  const CLAIM_IDS = ['illegal_termination', 'economic_compensation', 'notice_pay', 'double_wage', 'unpaid_wages', 'reinstatement'];
  function pickClaims(arr) {
    const out = {};
    for (const c of Array.isArray(arr) ? arr : []) if (c && CLAIM_IDS.includes(c.claim)) { const n = +String(c.amount == null ? '' : c.amount).replace(/[,，元\s]/g, ''); out[c.claim] = n > 0 ? n : null; }
    return out;
  }
  function keywordClaims(text) {
    const out = {};
    const amt = re => { const m = text.match(re); return m ? +m[1].replace(/,/g, '') * (m[2] ? 10000 : 1) || null : null; };
    if (/2N|违法解除.*赔偿|赔偿金/.test(text)) out.illegal_termination = amt(/(?:2N|赔偿金)[^\d]{0,6}([\d,.]+)\s*(万)?/);
    if (/二倍工资|双倍工资/.test(text)) out.double_wage = amt(/(?:二倍|双倍)工资[^\d]{0,6}([\d,.]+)\s*(万)?/);
    if (/经济补偿|补偿金/.test(text) && !out.illegal_termination) out.economic_compensation = amt(/(?:经济补偿|补偿金)[^\d]{0,6}([\d,.]+)\s*(万)?/);
    if (/代通知金|N\+1/.test(text)) out.notice_pay = null;
    return out;
  }
  const PARTY_KEYS = ['applicant_name', 'applicant_gender', 'applicant_phone', 'applicant_id_no', 'applicant_address', 'company_name', 'company_address', 'legal_rep'];
  const pickParties = o => Object.fromEntries(PARTY_KEYS.filter(k => typeof o[k] === 'string' && o[k].trim()).map(k => [k, o[k].trim()]));
  function keywordParties(text) {
    const out = {};
    const phone = text.match(/(?<!\d)1[3-9]\d{9}(?!\d)/); if (phone) out.applicant_phone = phone[0];
    const id = text.match(/(?<!\d)\d{17}[\dXx](?!\d)/); if (id) out.applicant_id_no = id[0].toUpperCase();
    const name = text.match(/我叫([\u4e00-\u9fa5]{2,4}?)(?=[，。,\s]|$)/); if (name) out.applicant_name = name[1];
    return out;
  }
  async function extract(text, facts, currentSlot, evidenceOptions) {
    const sample = await samplePromise;
    if (sample) {
      const prompt = `你是劳动争议咨询助手，只做一件事：从劳动者的话里抽取事实，输出 JSON。
今天是 ${today()}。相对时间（上个月、去年）换算成具体日期。
只输出用户明确说了或能直接推出的字段，没提到的不要输出，不要猜。不要给法律结论，不要算金额。
${currentSlot ? `刚才问用户的问题是：「${currentSlot.ask}」（对应字段 ${currentSlot.key}）。\n` : ''}已知事实：${JSON.stringify(facts)}
字段与取值：
${SLOT_SCHEMA}
${evidenceOptions ? `另外输出 evidence：用户说自己手上有的证据，只能从这个清单里选：${evidenceOptions.join('、')}\n输出格式：{"facts": {...}, "evidence": [...]}` : '输出格式：{"facts": {...}}'}

用户说：${text}`;
      try {
        const r = await sample.json(prompt, { modelTier: 'quick' });
        model.status = 'Claude';
        if (r && typeof r === 'object') return { facts: { ...clean(r.facts || {}), ...owedDetail((r.facts || {}).wages_owed_detail) }, parties: pickParties(r.facts || {}), claims: pickClaims((r.facts || {}).user_claims), evidence: (evidenceOptions && Array.isArray(r.evidence) ? r.evidence.filter(e => evidenceOptions.includes(e)) : []), by: 'model' };
      } catch (e) {
        if (e && e.code === 'not_granted') { model.ok = false; model.status = '关键词版（你没有授权使用 Claude）'; }
      }
    }
    const kw = F.keywordExtract(text, today());
    const city = findCity(text);
    if (city) kw.city = city;
    if (currentSlot && !kw[currentSlot.key]) Object.assign(kw, directAnswer(currentSlot, text));
    const has = o => { const i = text.indexOf(o); return i >= 0 && !/[没未无不]/.test(text.slice(Math.max(0, i - 4), i)); };
    const evidence = (evidenceOptions || []).filter(o => has(o) || (o === '通话录音' && /录音/.test(text)) || (o === '辞退聊天记录' && /聊天|截图/.test(text) && /辞|别来/.test(text)));
    return { facts: kw, parties: keywordParties(text), claims: keywordClaims(text), evidence, by: 'keyword' };
  }

  // 只收清单里有的字段和合法取值
  function clean(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'other_issues' && Array.isArray(v)) { out[k] = v.filter(x => ['overtime', 'annual_leave', 'social_insurance', 'work_injury', 'platform_work', 'dispatch', 'subcontract'].includes(x)); continue; }
      const s = F.SLOTS[k];
      if (!s || v === null || v === '') continue;
      if (s.type === 'choice' && !s.options.some(o => o.value === v)) continue;
      if (s.type === 'number') { const n = +v; if (!isNaN(n) && n > 0) out[k] = n; continue; }
      if (s.type === 'date') { const d = parseDate(String(v)); if (d) out[k] = d; continue; }
      if (s.type === 'city') { const c = findCity(String(v)); if (c) out[k] = c; continue; }
      out[k] = v;
    }
    return out;
  }

  function parseDate(s) {
    const m = s.match(/(\d{4})\s*[年\-./]\s*(\d{1,2})(?:\s*[月\-./]\s*(\d{1,2}))?/);
    if (!m) return null;
    const p = n => String(n).padStart(2, '0');
    return `${m[1]}-${p(m[2])}-${p(m[3] || 1)}`;
  }

  // 在一句话里找城市名：先找完整的地级市名，再去掉「市」「地区」等后缀比
  const CITY_NAMES = G.PROVINCES.flatMap(p => p.cities).sort((a, b) => b.length - a.length);
  const short = c => c.replace(/(市|地区|盟|林区)$/, '').replace(/(土家族|苗族|藏族|羌族|彝族|朝鲜族|蒙古族|哈尼族|壮族|傣族|白族|景颇族|傈僳族|布依族|侗族|回族|柯尔克孜|哈萨克|蒙古|自治州|自治)+$/, '');
  function findCity(text) {
    for (const c of CITY_NAMES) if (text.includes(c)) return c;
    for (const c of CITY_NAMES) { const s = short(c); if (s.length >= 2 && text.includes(s)) return c; }
    return null;
  }

  function directAnswer(slot, text) {
    if (slot.type === 'city') { const c = findCity(text); return c ? { city: c } : {}; }
    if (slot.type === 'number') { const m = text.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(万)?/); return m ? { [slot.key]: parseFloat(m[1]) * (m[2] ? 10000 : 1) } : {}; }
    if (slot.type === 'date') { const d = parseDate(text); return d ? { [slot.key]: d } : {}; }
    if (slot.type === 'text') return { [slot.key]: text.trim() };
    return {};
  }

  // 事实与理由：把对话、补正、材料识别、证据、请求合并成一份记录（flow.buildRecord，不含金额和待确认参数），交模型总结
  async function draftReasons(st, claims, record, evidenceList) {
    const fallback = templateReasons(st, claims);
    const sample = await samplePromise;
    if (!sample) return fallback;
    const prompt = `请根据下面这份劳动争议案件记录，为劳动仲裁申请书总结「事实与理由」部分。
要求：第三人称称「申请人」「被申请人」；把对话、补充细节、材料里的事实合并去重，按时间顺序陈述；只使用记录里有的事实，不要补充任何记录里没有的事实、日期或数字；不要写任何金额；不要做法律定性，不要写法条；关键事实后用括号标出能证明它的证据编号，如「（见证据 2：辞退聊天记录）」，只能用下面证据目录里的编号；最后一段写「为维护申请人的合法权益，特依法申请仲裁，请求支持申请人的仲裁请求。」；400 字以内；只输出正文。
案件记录：${JSON.stringify(record)}
证据目录：${(evidenceList || []).map((t, i) => `证据 ${i + 1}：${t}`).join('；') || '暂无'}`;
    try {
      const r = await sample(prompt, { cache: false });
      const text = (r.text || '').trim();
      // 代码校验：出现金额或记录里没有的日期，就不用模型稿，退回代码模板
      return text && !W.checkReasons(text, st.facts, record.user_words).length ? text : fallback;
    } catch (e) { return fallback; }
  }

  function templateReasons(st, claims) {
    const f = st.facts, L = labelOf;
    const parts = [];
    parts.push(`申请人于 ${f.start_date || '____'} 入职被申请人${f.company_name ? '（' + f.company_name + '）' : ''}，月工资约 ${f.monthly_wage ? E.yuan(f.monthly_wage) : '____'} 元。`);
    if (f.signed_contract) parts.push(`双方${f.signed_contract === 'yes' ? '签订了' : f.signed_contract === 'later' ? '于 ' + (f.contract_signed_date || '____') + ' 补签了' : '未签订'}书面劳动合同。`);
    if (f.separation === 'company_terminated') parts.push(`${f.end_date || '____'}，被申请人以${{ written: '书面', chat: '微信或短信', oral: '口头' }[f.termination_form] || '____'}方式通知申请人解除劳动关系，${f.termination_reason === 'none' ? '未说明任何理由' : '理由为' + (L('termination_reason', f.termination_reason) || '____')}。`);
    for (const t of (st.supplements || []).map(x => x.text)) parts.push('申请人补充：' + (/[。！？]$/.test(t) ? t : t + '。'));
    if (f.wages_owed === 'yes') parts.push(`被申请人尚欠申请人工资 ${f.wages_owed_amount ? E.yuan(f.wages_owed_amount) : '____'} 元未支付。`);
    parts.push('为维护申请人的合法权益，特依法申请仲裁，请求支持申请人的仲裁请求。');
    return parts.join('\n');
  }

  function labelOf(key, value) {
    const s = F.SLOTS[key];
    if (!s || value == null) return '';
    if (s.options) { const o = s.options.find(o => o.value === value); return o ? o.label : value; }
    return String(value);
  }

  // ---------- 状态 ----------
  const STORE = 'la-cases-v1';
  function loadCases() { try { return JSON.parse(localStorage.getItem(STORE) || '[]'); } catch (e) { return []; } }
  function saveCases(list) { try { localStorage.setItem(STORE, JSON.stringify(list)); } catch (e) { } }

  function blankCase() {
    return {
      id: 'c' + Date.now(), updated: null, page: 'P1', facts: {}, manual: {}, uncertain: {}, pending: {}, supplements: [], evPurpose: {}, sources: {}, autoTicked: [], asks: [], archive: [], confirmed: false, userClaims: {},
      chat: [{ role: 'ai', text: GREETING }], evidence: { labor_relation: [], wage: [], termination: [] }, selected: [], recognized: [], avgWage: null, minWage: null, regAvgWage: null, regMinWage: null,
      app: { applicant: { name: '', gender: '', ethnicity: '', birth: '', hukou: '', id_type: '居民身份证', id_no: '', address: '', phone: '', service_address: '', email: '' },
        respondent: { name: '', company_type: '', credit_code: '', legal_rep: '', legal_rep_title: '', address: '', office_address: '', contact: '', contact_title: '', phone: '' }, reasons: '', step: 1,
        agent: { on: false, type: 'general', name: '', gender: '', age: '', work: '', residence: '', phone: '' } },
      checked: {}, submission: { submitted: '', receiptNo: '', accepted: '', evidenceDeadline: '', hearing: '', awardReceived: '', finalAward: false },
    };
  }

  const GREETING = '你好，我是劳动仲裁助手。先说说发生了什么：在哪个城市上班、干了多久、工资多少、公司做了什么。说不全也没关系，我再接着问。\n如果你已经了解过，也可以把你的结论（比如想要 2N 赔偿、算的金额）和手上的材料一次发过来，点「＋材料」上传合同、身份证、聊天截图等。我会核对哪些对，你只需要确认，缺的再问你。';
  const PAGES = [
    { id: 'P1', name: '对话' }, { id: 'P2', name: '分析' }, { id: 'P3', name: '测算' },
    { id: 'P4', name: '报告' }, { id: 'P5', name: '证据' }, { id: 'P6', name: '申请书' },
    { id: 'P7', name: '提交包' }, { id: 'P8', name: '怎么交' }, { id: 'P9', name: '时间线' },
  ];

  createApp({
    setup() {
      const st = reactive(blankCase());
      const ui = reactive({ reply: '', busy: false, drawer: false, cases: loadCases(), tab: 'detail', missing: [], focusQ: '', supp: '', evBusy: false, exportText: '', editing: false, toast: '' });

      const allCities = G.PROVINCES.flatMap(p => p.cities.map(c => ({ city: c, province: p.province })));
      // 社平工资按「用人单位所在」城市取，最低工资同；年度取解除时的上年度（校准文档 L-04、4.1）
      // 社平工资和最低工资按劳动合同履行地（工作城市）取；注册地标准更高且合同约定按注册地执行时，才取注册地（实施条例第 14 条）
      function stdOf(city, avg, min) {
        const s = city && G.provinceOf(city) ? G.standardsFor(city, st.facts.end_date || today()) : null;
        if (!s) return null;
        const out = { ...s, origin: { ...s.origin } };
        if (avg) { out.avg_wage = +avg; out.origin.avg_wage = '你填写'; }
        if (min) { out.min_wage = +min; out.origin.min_wage = '你填写'; }
        return out;
      }
      const std = computed(() => {
        const work = stdOf(st.facts.city, st.avgWage, st.minWage);
        if (!st.facts.agreed_registered_std) return work;
        const reg = stdOf(st.facts.company_city, st.regAvgWage, st.regMinWage);
        return reg && reg.avg_wage && (!work || !work.avg_wage || reg.avg_wage > work.avg_wage) ? reg : work;
      });
      const stdCity = computed(() => std.value ? std.value.city : st.facts.city);
      const analysis = computed(() => E.analyze(st.facts, std.value, st.evidence, today()));
      const chosen = computed(() => analysis.value.claims.filter(c => st.selected.includes(c.id)));
      const conflicts = computed(() => E.conflicts(st.selected));
      const totals = computed(() => E.totals(chosen.value));
      const next = computed(() => F.nextSlot(st.facts, st.uncertain));
      const prog = computed(() => F.progress(st.facts));
      const factRows = computed(() => F.neededSlots(st.facts).map(({ key }) => ({ key, ...F.SLOTS[key], value: st.facts[key] })));
      const evidenceGroups = computed(() => {
        const groups = new Set(chosen.value.flatMap(c => R.CLAIMS[c.id].key_evidence));
        return R.EVIDENCE.filter(g => groups.has(g.group));
      });
      // 有区级数据的城市（目前是北京）按工作地所在区推荐仲裁委
      const districtName = d => d === '经开区' ? `${st.facts.city}经济技术开发区劳动人事争议仲裁委员会` : `${st.facts.city}市${d}${/[区县市]$/.test(d) ? '' : '区'}劳动人事争议仲裁委员会`;
      // 分流题是否适用：有的城市只对部分区问（广州、深圳），其余区一律归区
      const triageOn = computed(() => {
        const t = (std.value && std.value.application_format || {}).triage;
        return !!t && (!t.districts || t.districts.includes(st.facts.district));
      });
      const arbitration = computed(() => {
        if (!st.facts.city) return '';
        const fmt = std.value && std.value.application_format || {}, ds = fmt.districts;
        if (triageOn.value && st.facts.city_level === 'yes') return fmt.triage.yes.name;
        if (ds && st.facts.district && st.facts.district in ds) return districtName(st.facts.district);
        return `${st.facts.city}${/(市|自治州|盟|地区|林区)$/.test(st.facts.city) ? '' : '市'}劳动人事争议仲裁委员会`;
      });
      const institution = computed(() => {
        const f = std.value && std.value.application_format || {};
        if (triageOn.value && st.facts.city_level === 'yes') return f.triage.yes;
        return f.districts && st.facts.district ? f.districts[st.facts.district] : f.institution;
      });
      // 区县：从对话或公司住所里认出来（工作地优先，用户可在提交指引页改）
      watch(() => [st.facts.city, st.app.respondent.address, st.chat.length], () => {
        const ds = (std.value && std.value.application_format || {}).districts;
        if (!ds || st.facts.district) return;
        const find = text => Object.keys(ds).find(d => d === '经开区' ? /经开区|亦庄|经济技术开发区/.test(text) : text.includes(/[区县市]$/.test(d) ? d : d + '区'));
        const said = find(st.chat.filter(m => m.role === 'user').map(m => m.text).join(' '));
        const addr = find(st.app.respondent.address || '');
        if (said || addr) { st.facts.district = said || addr; st.sources.district = said ? '你在对话里说的' : '公司住所（如果工作地在别的区，请改）'; }
      });

      function persist() {
        st.updated = new Date().toISOString();
        const list = loadCases().filter(c => c.id !== st.id);
        list.unshift(JSON.parse(JSON.stringify(st)));
        saveCases(list.slice(0, 20));
        ui.cases = loadCases();
      }
      watch(st, persist, { deep: true });

      // ---------- 信息链：所有来源（对话、补正、照片、点选、手改）都写进同一份案件数据，并记下来源 ----------
      const ALL_EVIDENCE = R.EVIDENCE.flatMap(g => g.options);
      function merge(found, source) {
        source = source || '你在对话里说的';
        const changed = [];
        for (const [k, v] of Object.entries(found)) {
          if (st.manual[k]) continue;
          if (k === 'other_issues') { st.facts.other_issues = [...new Set([...(st.facts.other_issues || []), ...v])]; continue; }
          if (st.facts[k] === v) continue;
          // 用户确认过事实以后，AI 不能直接改影响请求或金额的字段，只能提出来让用户选
          const old = st.facts[k];
          if (st.confirmed && old != null && old !== '' && (D.DECISIVE.includes(k) || W.CALC_KEYS.includes(k))) {
            addAsk({ key: k, label: (F.SLOTS[k] || {}).label || k, values: [{ v: old, source: st.sources[k] || '你之前说的' }, { v, source }] });
            continue;
          }
          st.facts[k] = v; st.sources[k] = source; changed.push(k); if (W.CALC_KEYS.includes(k)) st.pending[k] = true;
        }
        return changed;
      }
      // 由已知事实推出的值（如按月数算欠薪合计），代码算，标「待确认」
      function applyDerived() {
        const d = F.derive(st.facts), keys = [];
        for (const [k, v] of Object.entries(d)) if (!st.manual[k] && st.facts[k] !== v) { st.facts[k] = v; st.sources[k] = '按你说的月数和金额计算'; keys.push(k); if (W.CALC_KEYS.includes(k)) st.pending[k] = true; }
        return keys;
      }
      // 来源之间对不上、又会影响请求或金额时，弹卡问用户以哪个为准；选完两个值都留档
      function addAsk(a) {
        if (st.asks.some(x => x.key === a.key && x.values.some(y => y.v === a.values[1].v))) return;
        st.asks.push(a);
      }
      function resolveAsk(i, val) {
        const a = st.asks[i];
        st.facts[a.key] = val.v; st.manual[a.key] = true; st.sources[a.key] = '你确认的';
        delete st.pending[a.key];
        st.archive.push({ ...a, chosen: val.v, at: new Date().toISOString() });
        st.asks.splice(i, 1);
      }
      // 抽取结果整体入链：事实、当事人信息、提到的证据
      function ingest(r, source) {
        const changed = merge(r.facts, source);
        changed.push(...applyDerived());
        const party = D.apply('chat', r.parties || {}, { facts: st.facts, manual: st.manual, applicant: st.app.applicant, respondent: st.app.respondent, sources: st.sources }, source);
        (party.asks || []).forEach(addAsk);
        const ticked = tickEvidence(r.evidence || []);
        const claims = Object.keys(r.claims || {});
        for (const id of claims) st.userClaims[id] = r.claims[id] != null ? r.claims[id] : (st.userClaims[id] != null ? st.userClaims[id] : null);
        return { changed, party: party.filled, ticked, claims };
      }
      function tickEvidence(tags) {
        const ticked = [];
        for (const tag of tags) {
          const g = R.EVIDENCE.find(g => g.options.includes(tag));
          if (g && !st.evidence[g.group].includes(tag)) { st.evidence[g.group].push(tag); ticked.push(tag); }
        }
        return ticked;
      }
      // 对话里说过的材料（如「有社保」「微信上通知的」）对应的证据，自动勾上一次；用户取消后不再勾
      watch(() => D.impliedEvidence(st.facts).map(x => x[1]).join(), () => {
        const tags = D.impliedEvidence(st.facts).map(x => x[1]).filter(t => !st.autoTicked.includes(t));
        st.autoTicked.push(...tags); tickEvidence(tags);
      }, { immediate: true });
      // 营业执照、合同上读到公司住所后，带出注册地城市（用于注册地标准）
      watch(() => st.app.respondent.address, a => {
        const c = a && findCity(a);
        if (c && !st.facts.company_city && !st.manual.company_city) { st.facts.company_city = c; st.sources.company_city = st.sources['respondent.address'] || '公司住所'; }
      }, { immediate: true });

      function recapOf(keys) {
        return keys.filter(k => F.SLOTS[k]).map(k => `${F.SLOTS[k].label}：${display(k, st.facts[k])}`).join('；');
      }
      function display(k, v) {
        if (v == null || v === '') return '未填';
        const s = F.SLOTS[k];
        if (s && s.type === 'number') return E.yuan(+v) + ' 元';
        return labelOf(k, v);
      }

      const routed = new Set();
      function askNext() {
        for (const r of analysis.value.routes) if (!routed.has(r.id)) {
          routed.add(r.id);
          st.chat.push({ role: 'ai', text: `提醒：你说的情况涉及「${r.title}」。${r.why}我先把其他事实问完，分析页会单独列出建议。` });
        }
        const n = next.value;
        if (!n) { st.chat.push({ role: 'ai', text: '主要事实都了解了。下面是我记下的事实，请核对一下，有不对的可以直接改。', summary: true }); return; }
        st.chat.push({ role: 'ai', text: n.useAlt ? n.alt : n.ask, slot: n.key, options: n.options || null, type: n.type, usedBy: n.usedBy });
      }

      async function answer(text) {
        text = (text || ui.reply).trim();
        if (!text || ui.busy) return;
        const first = !st.chat.some(m => m.role === 'user');
        const slot = first ? null : next.value;
        st.chat.push({ role: 'user', text }); ui.reply = '';
        ui.busy = true; scrollChat();
        const r = await extract(text, st.facts, slot, ALL_EVIDENCE);
        // 已有城市时，只有在问城市这一步才改（避免公司名里的地名把城市覆盖掉）
        if (st.facts.city && !(slot && slot.key === 'city')) delete r.facts.city;
        const { changed, party, ticked, claims } = ingest(r, '你在对话里说的');
        ui.busy = false;
        const extra = (party.length ? `申请书里的${party.join('、')}已帮你填上。` : '') + (ticked.length ? `证据清单已勾上：${ticked.join('、')}。` : '')
          + (claims.length ? `你提到要主张：${claims.map(id => R.CLAIMS[id].title + (st.userClaims[id] != null ? `（你算的 ${E.yuan(st.userClaims[id])} 元）` : '')).join('、')}。我会按你的事实逐项核对能不能主张，金额按法定公式重算后和你的对照。` : '');
        if (first) st.chat.push({ role: 'ai', text: changed.length ? `我先复述一下听懂的：${recapOf(changed)}。${extra}` : extra || '好的，我们一个个来。' });
        else if (changed.length || extra) st.chat.push({ role: 'ai', text: (changed.length ? `记下了：${recapOf(changed)}。` : '') + extra });
        else if (slot) { st.uncertain[slot.key] = (st.uncertain[slot.key] || 0) + 1; st.chat.push({ role: 'ai', text: '这个我没太读懂，换个方式问。' }); }
        askNext(); scrollChat();
      }

      function pick(slotKey, opt) {
        st.chat.push({ role: 'user', text: opt.label });
        st.facts[slotKey] = opt.value; st.sources[slotKey] = '你选的'; delete st.pending[slotKey];
        askNext(); scrollChat();
      }
      function notSure(slotKey) {
        st.chat.push({ role: 'user', text: '不确定' });
        st.uncertain[slotKey] = (st.uncertain[slotKey] || 0) + 1;
        if (st.uncertain[slotKey] >= 2) st.chat.push({ role: 'ai', text: '没关系，这一项先跳过，后面在事实摘要里随时可以补。' });
        askNext(); scrollChat();
      }
      function scrollChat() { nextTick(() => { const el = document.getElementById('chat-end'); if (el) el.scrollIntoView({ block: 'end', behavior: 'smooth' }); }); }

      function editFact(k, v) {
        const s = F.SLOTS[k] || F.PARAM_SLOTS[k];
        delete st.pending[k];
        if (v === '' || v == null) { delete st.facts[k]; delete st.manual[k]; return; }
        st.facts[k] = s.type === 'number' ? +v : v;
        st.manual[k] = true; st.sources[k] = '你改的';
      }
      // 用户核对后确认：模型读出的计算参数从「待确认」转为「已确认」，之后才出金额
      const pendingKeys = computed(() => W.unconfirmed(st.facts, st.pending));
      function confirmParams() { st.pending = {}; st.confirmed = true; }
      const gate = computed(() => {
        const g = baseGate.value;
        const miss = W.requiredMissing(st.app, chosen.value);
        const lock = { open: g.P6.open && !miss.length, why: g.P6.open ? (miss.length ? ['申请书还缺：' + miss.join('、')] : []) : ['先完成上一步'] };
        return { ...g, P7: lock, P8: lock, P9: lock };
      });
      const baseGate = computed(() => W.gates({ facts: st.facts, pending: st.pending, selected: st.selected, conflicts: conflicts.value, chosen: chosen.value, started: st.chat.some(m => m.role === 'user') }));

      function toAnalysis(confirm) {
        if (confirm === true) confirmParams();
        // 默认勾选：先按离职方式对应的补偿类型（2N / N / N+代通知金），再补上不互斥的其他请求；恢复劳动关系不默认勾
        const mine = Object.keys(st.userClaims).filter(id => analysis.value.claims.some(c => c.id === id));
        if (!st.selected.length && mine.length) { for (const id of mine) if (!E.conflicts([...st.selected, id]).length) st.selected.push(id); }
        if (!st.selected.length) {
          const pref = { '2N': ['illegal_termination'], N: ['economic_compensation'], 'N+notice': ['economic_compensation', 'notice_pay'] }[(analysis.value.severance || {}).type] || [];
          const ids = analysis.value.claims.map(c => c.id).filter(id => id !== 'reinstatement');
          const pick = [];
          for (const id of [...pref.filter(id => ids.includes(id)), ...ids]) if (!pick.includes(id) && !E.conflicts([...pick, id]).length) pick.push(id);
          st.selected = pick;
        }
        st.page = 'P2';
        window.scrollTo(0, 0);
      }
      function toggleClaim(id) {
        const i = st.selected.indexOf(id);
        if (i >= 0) st.selected.splice(i, 1); else st.selected.push(id);
      }
      // 点证据标签：没勾的勾上并请用户上传照片（取消上传也保持勾选）；已勾的再点取消
      function toggleEvidence(group, opt) {
        const arr = st.evidence[group];
        const i = arr.indexOf(opt);
        if (i >= 0) { arr.splice(i, 1); return; }
        arr.push(opt);
        upload(D.kindOfTag(opt), opt, group + '|' + opt);
      }

      // ---------- 上传与识别 ----------
      const files = reactive({});          // 本次打开页面上传的文件，只在内存里，刷新后不保留
      function upload(kind, tag, slot) {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true;
        inp.accept = imgCaps.ok ? imgCaps.accept + ',application/pdf' : 'image/*,application/pdf';
        inp.onchange = () => { const list = [...inp.files]; if (list.length) recognize(kind, tag, slot || tag, list); };
        inp.click();
      }
      // 第一轮对话里直接传材料：每张单独识别类型，读到的写进信息链、勾上证据，在对话里回报
      function uploadInChat() {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.accept = imgCaps.ok ? imgCaps.accept + ',application/pdf' : 'image/*,application/pdf';
        inp.onchange = async () => {
          const list = [...inp.files]; if (!list.length) return;
          st.chat.push({ role: 'user', text: `上传了 ${list.length} 份材料：${list.map(f => f.name).join('、')}` });
          ui.busy = true; scrollChat();
          const lines = [];
          for (const f of list) {
            const r = await recognize('auto', '', 'chat|' + f.name, [f]);
            lines.push(`「${r.tag}」` + (r.filled.length ? `：记下了${r.filled.join('、')}` : '') + (r.ticked ? '，已放进证据清单' : '') + (r.note ? `（${r.note}）` : ''));
          }
          ui.busy = false;
          st.chat.push({ role: 'ai', text: lines.join('\n') + (st.asks.length ? '\n有和你说的对不上的地方，请在上方选以哪个为准。' : '') + (W.CALC_KEYS.some(k => st.pending[k]) ? '\n读到的日期和工资在测算页核对一下就行。' : '') });
          askNext(); scrollChat();
        };
        inp.click();
      }
      async function recognize(kind, tag, slot, list) {
        files[slot] = [...(files[slot] || []), ...list.map(f => ({ name: f.name, url: URL.createObjectURL(f) }))];
        const imgs = imgCaps.ok ? list.filter(f => imgCaps.accept.split(',').includes(f.type)).slice(0, imgCaps.max) : [];
        const rec = { tag: tag || '材料', kind, ticked: false, at: new Date().toISOString(), filled: [], conflicts: [], keys: [], confirmed: false, note: '', busy: true };
        st.recognized.unshift(rec);
        const r = st.recognized[0];
        if (!imgs.length) {
          r.busy = false;
          r.note = imgCaps.ok ? '已附上。PDF 暂时不能识别，请上传照片或截图。' : '已附上。当前环境不能识别图片，相关信息请手动填写。';
          return r;
        }
        try {
          const sample = await samplePromise;
          const data = await sample.json(D.prompt(kind, tag, ALL_EVIDENCE), { images: imgs });
          if (kind === 'auto') {
            kind = D.KINDS[data && data.kind] ? data.kind : 'other';
            tag = ALL_EVIDENCE.includes(data && data.tag) ? data.tag : D.KINDS[kind].title;
            r.kind = kind; r.tag = tag;
            if (ALL_EVIDENCE.includes(tag)) r.ticked = tickEvidence([tag]).length > 0;
            if (data && data.summary && !/元/.test(data.summary)) r.note = String(data.summary);
          }
          if (data && data.doc_ok === false) r.note = `这张看起来不像「${tag}」，请确认上传的文件。`;
          const before = Object.fromEntries(W.CALC_KEYS.map(k => [k, st.facts[k]]));
          const out = D.apply(kind, data, { facts: st.facts, manual: st.manual, applicant: st.app.applicant, respondent: st.app.respondent, sources: st.sources }, `${tag}照片`);
          r.keys = W.CALC_KEYS.filter(k => st.facts[k] !== before[k]);
          for (const k of r.keys) st.pending[k] = true;
          out.asks.forEach(addAsk);
          r.filled = out.filled; r.conflicts = out.conflicts;
          if (out.wage) r.note = `按 ${out.wage.from} 至 ${out.wage.to} 共 ${out.wage.months} 个月的应发工资，平均月工资 ${E.yuan(out.wage.value)} 元（代码计算）。`;
          if (out.asks.length) r.note = (r.note ? r.note + ' ' : '') + '有和之前不一致的地方，请在页面上方选以哪个为准。';
          if (out.reason) r.note = (r.note ? r.note + ' ' : '') + `材料上写的解除理由：「${out.reason}」`;
          if (!out.filled.length && !out.conflicts.length && !r.note) r.note = '没有读到新的信息。';
        } catch (e) {
          r.note = e && e.code === 'not_granted' ? '你没有授权使用 Claude，没法识别，相关信息请手动填写。' : '识别没有成功，可以换一张清楚点的照片再试。';
        }
        r.busy = false;
        return r;
      }
      // ---------- 补正：报告之后，用户想到什么说什么（质证、补充细节、手上有什么证据） ----------
      // 照样走「模型抽事实 → 代码合并（计算参数待确认）→ 代码重算」，前后变化由代码列出；提到的证据自动勾上
      const record = computed(() => W.buildRecord({ ...st, chosen: chosen.value }));
      async function supplement() {
        const text = ui.supp.trim();
        if (!text || ui.busy) return;
        const before = Object.fromEntries(chosen.value.map(c => [c.id, { tier: c.tier, amount: c.calc && c.calc.amount }]));
        const beforeIds = analysis.value.claims.map(c => c.id);
        const options = ALL_EVIDENCE;
        ui.supp = ''; ui.busy = true;
        const r = await extract(text, st.facts, null, options);
        if (st.facts.city) delete r.facts.city;
        const { changed, party, ticked } = ingest(r, '你补充的');
        ui.busy = false;
        const diffs = [];
        const now = analysis.value.claims;
        for (const c of now) {
          const b = before[c.id];
          if (!b) { if (!beforeIds.includes(c.id)) diffs.push(`新出现可主张的请求：${c.title}`); continue; }
          if (b.tier !== c.tier) diffs.push(`${c.title}：${b.tier} → ${c.tier}`);
          if (!pendingKeys.value.length && c.calc && b.amount !== c.calc.amount) diffs.push(`${c.title}：金额 ${b.amount != null ? E.yuan(b.amount) : '—'} → ${c.calc.amount != null ? E.yuan(c.calc.amount) : '—'} 元`);
        }
        for (const id of Object.keys(before)) if (!now.some(c => c.id === id)) diffs.push(`${R.CLAIMS[id].title}：按补充的事实已不成立，已取消勾选`);
        st.selected = st.selected.filter(id => now.some(c => c.id === id));
        if (party.length) diffs.push(`申请书里的${party.join('、')}已帮你填上`);
        st.supplements.push({ text, at: new Date().toISOString(), recap: recapOf(changed), ticked, diffs });
        st.evPurpose = {};   // 事实变了，证明内容要重新整理
      }

      // 证据目录的「证明内容」：模型根据合并记录逐项总结，代码校验（不许有金额和记录外日期），不合格用通用说明
      const evItems = computed(() => evidenceGroups.value.flatMap(g => st.evidence[g.group].map(tag => ({ tag, group: g, purpose: st.evPurpose[tag] || g.purpose }))));
      async function organizeEvidence() {
        const items = evItems.value;
        if (!items.length) { flash('先勾选手上有的证据'); return; }
        const sample = await samplePromise;
        if (!sample) { flash('当前环境用不了模型，证明内容先用通用说明'); return; }
        ui.evBusy = true;
        try {
          const r = await sample.json(`请为劳动仲裁证据目录逐项写「证明内容」：结合案件记录，说明每份证据能证明哪件具体的事、支持哪项请求，每项 50 字以内；只用记录里有的事实，不写金额，不做法律定性。
证据：${items.map(i => i.tag).join('、')}
案件记录：${JSON.stringify(record.value)}
只输出 JSON：{"items": [{"name": "证据名称", "purpose": "证明内容"}]}`, { modelTier: 'quick' });
          for (const it of (r && r.items) || []) {
            if (items.some(i => i.tag === it.name) && it.purpose && !W.checkReasons(it.purpose, st.facts, record.value.user_words).length) st.evPurpose[it.name] = String(it.purpose).trim();
          }
        } catch (e) { flash('整理没有成功，先用通用说明'); }
        ui.evBusy = false;
      }

      // 页面跳转由 flow.gates 决定，卡住时说明缺什么
      // 用户自己带来的结论 vs 代码结论：能不能主张、金额差多少（全由代码判断）
      const claimCheck = computed(() => {
        const out = { notApplicable: [], amounts: {} };
        for (const [id, amt] of Object.entries(st.userClaims)) {
          const c = analysis.value.claims.find(x => x.id === id);
          if (!c) {
            const why = Object.entries(R.CLAIMS[id].ruled_out_when || {}).filter(([k, vals]) => vals.includes(st.facts[k])).map(([k]) => `${F.SLOTS[k].label}：${labelOf(k, st.facts[k])}`);
            out.notApplicable.push({ title: R.CLAIMS[id].title, why: why.join('；') });
            continue;
          }
          if (amt != null) out.amounts[id] = { mine: amt, code: c.calc && c.calc.amount, same: c.calc && c.calc.amount != null && Math.abs(c.calc.amount - amt) < 1 };
        }
        return out;
      });
      // ---------- 行动链：能不能申请、提交包、提交指引、时间线（全部由 engine/procedure.js 的代码给出） ----------
      const eligible = computed(() => P.eligibility({ facts: st.facts, routes: analysis.value.routes, limitation: analysis.value.limitation, today: today(), arbitration: arbitration.value }));
      const respondents = computed(() => (st.facts.other_issues || []).includes('dispatch') ? 2 : 1);   // 劳务派遣：派遣单位和用工单位
      const copyCount = computed(() => P.copies(appFormat.value.copy_rule, respondents.value));
      const hasRecording = computed(() => Object.values(st.evidence).flat().some(t => /录音/.test(t)));
      const evPages = computed(() => evItems.value.reduce((n, it) => n + ((files[it.group.group + '|' + it.tag] || []).length), 0));
      const materialList = computed(() => P.materials({ copies: copyCount.value, hasAgent: st.app.agent.on, evidenceCount: evItems.value.length, evidencePages: evPages.value }));
      const checkItems = computed(() => P.checklist({ copies: copyCount.value, hasAgent: st.app.agent.on, hasRecording: hasRecording.value }));
      const events = computed(() => P.timeline(st.submission));
      // 时效不到 30 天不推荐邮寄：邮寄日算不算申请日没有明确规定（律师线程校准文档 7.9）
      const mailRisky = computed(() => eligible.value.items.some(i => i.label === '时效' && i.daysLeft != null && i.daysLeft < 30));
      const limitNear = computed(() => eligible.value.items.some(i => i.label === '时效' && i.status === 'risk'));
      // 回执拍照：模型只读日期和编号，写进时间线
      function uploadReceipt() {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = imgCaps.ok ? imgCaps.accept : 'image/*';
        inp.onchange = async () => {
          const f = inp.files[0]; if (!f) return;
          const sample = await samplePromise;
          if (!sample || !imgCaps.ok) { flash('当前环境不能识别图片，请手动填写提交日期'); return; }
          try {
            const r = await sample.json('这是劳动仲裁委出具的收件回执或受理通知书照片。只读照片上写着的：date（收件或受理日期 YYYY-MM-DD）、number（案号或收件编号）、kind（receipt 收件回执 | accepted 受理通知）。看不清的不要输出。只输出 JSON。', { images: [f] });
            if (r && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) { if (r.kind === 'accepted') st.submission.accepted = r.date; else st.submission.submitted = r.date; }
            if (r && r.number) st.submission.receiptNo = String(r.number);
            flash(r && r.date ? '已读出日期，请核对' : '没读到日期，请手动填写');
          } catch (e) { flash('识别没有成功，请手动填写'); }
        };
        inp.click();
      }
      // 线上平台填写对照表（目前是北京平台，按平台七步顺序；字段全部取自信息链和代码结果）
      const cut = (t, n) => String(t || '').slice(0, n);
      const platformSteps = computed(() => {
        const a = st.app.applicant, r = st.app.respondent, n = (appFormat.value.online && appFormat.value.online.upload || {}).nameMax || 30;
        return [
          { title: '申请人信息', note: '京通会自动带出，核对一下', rows: [['姓名', a.name], ['身份证号', a.id_no], ['联系电话', a.phone], ['住址', a.address]] },
          { title: '被申请人', note: '输入单位全称后，要从下拉列表里选中', rows: [['单位全称', r.name], ['统一社会信用代码', r.credit_code], ['住所', r.address], ['法定代表人', r.legal_rep]] },
          { title: '请求事项', note: '逐项添加：名称 + 金额 + 明细', rows: chosen.value.flatMap((c, i) => [[`第 ${i + 1} 项名称`, c.title], [`第 ${i + 1} 项金额（元）`, c.calc && c.calc.amount != null ? String(c.calc.amount) : '不涉及金额'], [`第 ${i + 1} 项明细`, c.calc && c.calc.formula || requestLines()[i]]]) },
          { title: '事实与理由', note: '单独一段，整段粘贴', rows: [['事实与理由', st.app.reasons]] },
          { title: '送达地址确认书', note: '选是否同意电子送达', rows: [['送达地址', a.service_address || a.address], ['电子邮箱', a.email], ['是否同意电子送达', a.email ? '同意' : '按你的意愿选']] },
          { title: '上传证据', note: `名称和证明事项各不超过 ${n} 字；一次只能传同一种格式`, rows: evItems.value.flatMap((it, i) => [[`证据 ${i + 1} 名称`, cut(it.tag, n)], [`证据 ${i + 1} 证明事项`, cut(it.purpose, n)], [`证据 ${i + 1} 页数`, String((files[it.group.group + '|' + it.tag] || []).length || '按实际张数')]]) },
          { title: '提交', note: '选仲裁委，选是否同意调解', rows: [['仲裁委', arbitration.value], ['是否同意调解', '按你的意愿选；同意调解不影响仲裁']] },
        ];
      });
      async function copyText(t) {
        try { await navigator.clipboard.writeText(String(t || '')); flash('已复制'); }
        catch (e) { flash('这里不能自动复制，请长按文字选择复制'); }
      }
      // 证据文件按清单顺序命名后打包（01-劳动合同-1.jpg …），线上上传或打印都用这个顺序
      async function saveEvidenceZip() {
        const zip = new JSZip(); let n = 0;
        for (const [i, it] of evItems.value.entries()) {
          for (const [j, f] of (files[it.group.group + '|' + it.tag] || []).entries()) {
            const ext = (f.name.match(/\.[a-z0-9]+$/i) || [''])[0];
            zip.file(`${String(i + 1).padStart(2, '0')}-${it.tag}-${j + 1}${ext}`, await (await fetch(f.url)).blob()); n++;
          }
        }
        if (!n) { flash('还没有上传证据文件。刷新页面后，之前上传的文件不会保留，需要重新上传'); return; }
        const dl = window.claude && window.claude.use ? await window.claude.use('downloads').catch(() => null) : null;
        if (!dl) { flash('当前环境不能下载文件'); return; }
        try { await dl.save({ filename: '证据文件（按清单顺序）.zip', data: await zip.generateAsync({ type: 'blob' }) }); flash('已交给浏览器保存'); }
        catch (e) { if (!(e && e.code === 'declined')) flash('打包下载没有成功'); }
      }
      async function saveIcs() {
        const text = P.ics(events.value, '劳动仲裁');
        const dl = window.claude && window.claude.use ? await window.claude.use('downloads').catch(() => null) : null;
        if (dl) { try { await dl.save({ filename: '劳动仲裁时间线.ics', data: new Blob([text], { type: 'text/calendar' }) }); flash('已交给浏览器保存，用手机日历打开即可提醒'); return; } catch (e) { if (e && e.code === 'declined') return; } }
        ui.exportText = text;
      }
      // 当事人信息是否已齐（证据页传身份证、营业执照后自动填）
      const partyMissing = computed(() => W.requiredMissing(st.app, [{}]).filter(m => /^(申请人|被申请人)/.test(m)));
      const partyDone = computed(() => ({ applicant: !partyMissing.value.some(m => /^申请人(姓名|性别|身份证号|住址)$/.test(m)), respondent: !partyMissing.value.some(m => /^被申请人/.test(m)) }));
      const suggestMiss = computed(() => W.suggestedMissing(st.app));
      // 补正引导问题：来自报告里「对方可能怎么说」，只帮用户想起来，不要求逐条回答
      const guideQs = computed(() => chosen.value.flatMap(c => c.defenses).slice(0, 4).map(d => `对方可能说「${d.says}」，当时是什么情况？`));
      // 申请书缺项时，告诉用户哪份材料能自动补上
      const fillHint = m => /^申请人(姓名|性别|身份证号|住址)$/.test(m) ? '在证据页传身份证可自动填写' : /^被申请人/.test(m) ? '在证据页传营业执照或劳动合同可自动填写' : '';
      // 识别卡上点「对」：这份材料读出的参数转为已确认
      function confirmRec(r) { for (const k of r.keys || []) delete st.pending[k]; r.confirmed = true; }

      function go(p) {
        const g = gate.value[p];
        if (g && !g.open) { flash(g.why.join('；')); return; }
        st.page = p; window.scrollTo(0, 0);
      }

      function newCase() { Object.assign(st, blankCase()); ui.drawer = false; }
      function openCase(c) { Object.assign(st, blankCase(), JSON.parse(JSON.stringify(c))); if (st.page === 'P0') st.page = 'P1'; ui.drawer = false; }

      // ---------- P6 校验 ----------
      // 只有法定必填项（当事人、请求、事实与理由）缺了才不让往下走；证据不足不拦，只在请求上标「需补证」
      function validate(step) {
        const all = W.requiredMissing(st.app, chosen.value);
        const roleLabels = role => Object.values(W.REQUIRED[role]);
        const miss = step === 1 ? all.filter(m => roleLabels('applicant').includes(m) || roleLabels('respondent').includes(m))
          : step === 2 ? all.filter(m => m === '至少一项仲裁请求') : all;
        ui.missing = miss;
        return !miss.length;
      }
      const reasonProblems = computed(() => W.checkReasons(st.app.reasons, st.facts, record.value.user_words));
      const appFormat = computed(() => (std.value && std.value.application_format) || {});
      function appNext() {
        if (!validate(st.app.step)) return;
        if (st.app.step === 1 && !st.app.respondent.name && st.facts.company_name) st.app.respondent.name = st.facts.company_name;
        st.app.step++;
        if (st.app.step === 3 && !st.app.reasons) draft();
      }
      function exportApp() { if (validate(3)) save('劳动人事争议仲裁申请书.docx', applicationDoc()); }
      async function draft() {
        ui.busy = true;
        st.app.reasons = await draftReasons(st, chosen.value, record.value, evItems.value.map(i => i.tag));
        ui.busy = false;
      }
      // 身份证号推出生日期和性别（纯代码，已填的不覆盖）
      watch(() => st.app.applicant.id_no, id => {
        const r = W.fromIdNo(id);
        for (const k of ['birth', 'gender']) if (r[k] && !st.app.applicant[k]) { st.app.applicant[k] = r[k]; st.sources['applicant.' + k] = '按身份证号推算'; }
      }, { immediate: true });
      // 对话里说的公司名称随时同步到被申请人名称（已填的不覆盖）
      watch(() => st.facts.company_name, n => { if (n && !st.app.respondent.name) { st.app.respondent.name = n; st.sources['respondent.name'] = st.sources.company_name || '你在对话里说的'; } }, { immediate: true });
      const src = path => st.sources[path] ? '来自' + st.sources[path] : '';

      function requestLines() { return W.requestLines(chosen.value, E.yuan); }

      // ---------- 导出 Word（.docx，用 JSZip 在浏览器里拼） ----------
      function xmlEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
      function run(text, bold, size) {
        return `<w:r><w:rPr><w:rFonts w:eastAsia="宋体"/>${bold ? '<w:b/>' : ''}<w:sz w:val="${size || 24}"/></w:rPr><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;
      }
      function para(b) {
        const jc = b.align ? `<w:jc w:val="${b.align}"/>` : '';
        return `<w:p><w:pPr>${jc}<w:spacing w:line="400" w:lineRule="auto"/></w:pPr>${b.label ? run(b.label, true) : ''}${run(b.text, b.bold, b.size)}</w:p>`;
      }
      function table(rows, plain) {
        const border = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(e => `<w:${e} w:val="single" w:sz="4" w:color="000000"/>`).join('') + '</w:tblBorders>';
        return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${border}</w:tblPr>` + rows.map((r, i) => '<w:tr>' + r.map(c => `<w:tc><w:p>${run(c, !plain && i === 0)}</w:p></w:tc>`).join('') + '</w:tr>').join('') + '</w:tbl>';
      }
      async function docx(blocks) {
        const body = blocks.map(b => b.pageBreak ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : b.table ? table(b.table, b.plain) : para(b)).join('');
        const zip = new JSZip();
        zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
        zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
        zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
        return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      }
      function evidenceDoc() {
        // 证据清单：序号、证据名称、证明目的、页数、备注；身份证、企业信息、送达地址确认书不列入
        const rows = [['序号', '证据名称', '证明目的', '页数', '备注']];
        evItems.value.forEach((it, i) => { const n = (files[it.group.group + '|' + it.tag] || []).length; rows.push([String(i + 1), it.tag, it.purpose, n ? String(n) : '', /录音/.test(it.tag) ? '附光盘及文字稿' : n ? '复印件，原件开庭出示' : '复印件待补']); });
        return [{ text: '证据目录', bold: true, size: 36, align: 'center' }, { table: rows }, { text: '' }, { label: '提交人：', text: st.app.applicant.name }, { text: today() }];
      }
      // 申请书：北京官方模板作全国底版（律师线程）。抬头按管辖结果自动填仲裁委；双方信息表；请求事项；事实和理由；附证据材料清单
      function applicationDoc() {
        const a = st.app.applicant, r = st.app.respondent, f = st.facts;
        const signed = { yes: '是', later: `是（${f.contract_signed_date || ''}补签）`, no: '否' }[f.signed_contract] || '';
        const place = [f.city, f.district && (f.district === '经开区' ? '经济技术开发区' : f.district + '区')].filter(Boolean).join('');
        const rows = [
          ['申请人', '', '被申请人', ''],
          ['姓名', a.name, '单位名称', r.name], ['性别', a.gender, '企业性质', r.company_type], ['民族', a.ethnicity, '统一社会信用代码', r.credit_code],
          ['出生日期', a.birth, '法定代表人（负责人）姓名', r.legal_rep], ['通讯地址', a.service_address || a.address, '职务', r.legal_rep_title],
          ['户口性质', a.hukou, '住所地', r.address], ['身份证件类型', a.id_type || '居民身份证', '劳动合同履行地', place], ['身份证件号码', a.id_no, '是否签合同', signed],
          ['联系电话', a.phone, '办公地或经营地', r.office_address], ['', '', '单位联系人', r.contact], ['', '', '部门及职务', r.contact_title], ['', '', '联系电话', r.phone],
        ];
        return [
          { text: '劳动人事争议仲裁申请书', bold: true, size: 36, align: 'center' },
          { text: `${arbitration.value}：` },
          { table: rows, plain: true },
          { label: '请求事项：', text: '' },
          ...requestLines().map((l, i) => ({ text: `${i + 1}. ${l}；` })),
          { label: '事实和理由：', text: '' },
          ...st.app.reasons.split('\n').filter(Boolean).map(t => ({ text: t })),
          { label: '证据和证据来源：', text: evItems.value.length ? `见所附证据材料清单（共 ${evItems.value.length} 项），均由申请人提供；无证人。` : '开庭前补充提交。' },
          { text: '申请人（签名或盖章）：____________', align: 'right' }, { text: '____年____月____日', align: 'right' },
          { text: `附：证据材料清单（第____页）` },
          ...(appFormat.value.print_note ? [{ text: '注：' + appFormat.value.print_note }] : []),
        ];
      }
      function serviceAddressDoc() {
        const a = st.app.applicant;
        return [
          { text: '送达地址确认书', bold: true, size: 36, align: 'center' },
          { table: [['当事人', a.name], ['身份证号', a.id_no], ['送达地址', a.service_address || a.address], ['收件人', a.name], ['联系电话', a.phone], ['电子邮箱', a.email || ''],
            ['是否同意电子送达', a.email ? '同意，以上述邮箱接收' : '□ 同意  □ 不同意']] },
          { text: '本人确认以上送达地址真实有效。仲裁委按上述地址送达的文书，即视为送达；地址变更的，本人将及时书面告知。' },
          { text: '确认人（签名）：____________', align: 'right' }, { text: '____年____月____日', align: 'right' },
        ];
      }
      // 授权委托书：北京官方模板（一般代理 / 特别代理二选一勾选）
      function powerOfAttorneyDoc() {
        const a = st.app.applicant, g = st.app.agent;
        const box = on => on ? '☑' : '□';
        return [
          { text: '授 权 委 托 书', bold: true, size: 36, align: 'center' },
          { text: `${arbitration.value}：` },
          { text: `你委受理的关于${a.name}与${st.app.respondent.name}的劳动（人事）争议一案，依照法律规定，现委托${g.name}为我的代理人，参加本案仲裁活动。` },
          { label: '委托代理人：', text: '' },
          { text: `姓名：${g.name}　性别：${g.gender}　年龄：${g.age}` },
          { text: `工作单位及职务：${g.work}` }, { text: `经常居住地：${g.residence}` }, { text: `联系电话：${g.phone}` },
          { text: '委托事项和代理权限如下（请在以下两项中选择其一进行勾选）：' },
          { text: `${box(g.type !== 'special')} 1.一般代理：代为提出仲裁申请、提交证据材料、申请回避、参加仲裁庭审活动、签署相关法律文书及庭审笔录等。` },
          { text: `${box(g.type === 'special')} 2.特别代理：除享有一般代理权外，可另代为承认、放弃、变更仲裁请求，进行和解，提起反申请。` },
          { text: '委托代理人在委托权限范围内签署的有关文书我方均予以承认，并承担法律责任。' },
          { text: '委托人（签名或盖章）：____________　　委托代理人（签名或盖章）：____________' },
          { text: '____年____月____日　　　　　　　　____年____月____日' },
        ];
      }
      function printListDoc() {
        return [
          { text: '打印与提交清单', bold: true, size: 36, align: 'center' },
          { text: `交到：${arbitration.value}。A4 纸单面打印；每套材料左上角订一个钉。` },
          { table: [['材料', '交仲裁委', '自留', '签名位置'], ...materialList.value.map(m => [m.name, String(m.count), String(m.keep || ''), m.sign || '—'])] },
          { text: `份数说明：${copyCount.value.note}。各地要求不同，多交不会被拒。` },
          { label: '开庭带原件：', text: evItems.value.map(i => i.tag).join('、') || '（还没勾选证据）' },
          { label: '出门前自查：', text: '' },
          ...checkItems.value.map(t => ({ text: '□ ' + t })),
        ];
      }
      // 打印包：一个 Word 文件，按清单顺序分页
      function printPackage() {
        const parts = [printListDoc(), applicationDoc(), evidenceDoc(), serviceAddressDoc(), ...(st.app.agent.on ? [powerOfAttorneyDoc()] : [])];
        return parts.flatMap((p, i) => i ? [{ pageBreak: true }, ...p] : p);
      }
      async function save(filename, blocks) {
        const dl = window.claude && window.claude.use ? await window.claude.use('downloads').catch(() => null) : null;
        if (dl && window.JSZip) {
          try { await dl.save({ filename, data: await docx(blocks) }); flash('已交给浏览器保存'); return; }
          catch (e) { if (e && (e.code === 'declined' || e.code === 'rate_limited')) return; }
        }
        ui.exportText = blocks.map(b => b.pageBreak ? '\n——————————\n' : b.table ? b.table.map(r => r.join('\t')).join('\n') : (b.label || '') + (b.text || '')).join('\n');
      }
      function flash(t) { ui.toast = t; setTimeout(() => { ui.toast = ''; }, 2500); }

      const examples = ['被辞退', '拖欠工资', '没签合同', '加班没给钱', '没交社保'];
      const EXAMPLE_TEXT = { 被辞退: '我被公司辞退了，', 拖欠工资: '公司拖欠我工资，', 没签合同: '公司一直没和我签劳动合同，', 加班没给钱: '经常加班但公司没给加班费，', 没交社保: '公司没给我交社保，' };
      function useExample(k) { ui.reply += EXAMPLE_TEXT[k]; }
      function fillSample() { ui.reply = '在苏州做了3年4个月仓库主管，月薪9000，上个月被口头通知明天别来了，没给理由，没签过劳动合同，工资每月微信转账'; }

      const tierClass = t => ({ 基本稳: 'solid', 需补证: 'need', 有争议: 'dispute' }[t]);
      const statusClass = s => ({ 已满足: 'ok', 初步满足: 'partial', 还需证据: 'need', 不满足: 'no' }[s]);
      const stdOrigin = k => { const w = stdOf(st.facts.city, st.avgWage, st.minWage); return w ? w.origin[k] : '待补'; };
      const pct = k => totals.value.total ? (totals.value[k] / totals.value.total * 100) + '%' : '0%';

      return { st, ui, R, E, F, G, PAGES, model, allCities, std, stdCity, stdOrigin, imgCaps, files, upload, kindOfTag: D.kindOfTag, analysis, chosen, conflicts, totals, next, prog, factRows, evidenceGroups, arbitration,
        answer, pick, notSure, editFact, toAnalysis, pendingKeys, confirmParams, gate, supplement, organizeEvidence, evItems, src, resolveAsk, confirmRec, guideQs, fillHint, suggestMiss, partyMissing, partyDone, claimCheck, uploadInChat, eligible, institution, platformSteps, copyText, saveEvidenceZip, copyCount, materialList, checkItems, events, limitNear, mailRisky, triageOn, uploadReceipt, saveIcs, serviceAddressDoc, powerOfAttorneyDoc, printListDoc, printPackage, hasRecording, reasonProblems, appFormat, W, toggleClaim, toggleEvidence, go, newCase, openCase, appNext, exportApp, draft, requestLines,
        save, evidenceDoc, applicationDoc, examples, useExample, fillSample, tierClass, statusClass, pct, display, labelOf, today };
    },
  }).mount('#app');
})();
