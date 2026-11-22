// 劳动仲裁 H5 测试版：页面状态与流程（P0–P6）。
// 三明治架构：两头靠模型吞吐非标信息（口述/照片 → 结构化参数；事实与理由润色），
// 中间靠纯代码锁死确定性（金额 engine.js、流程解锁 flow.js、文书句式 flow.js）。
// 模型读出的计算参数先进 st.pending，用户确认后才出金额；模型永远不直接给用户赔偿数字。
(function () {
  const { rules: R, regions: G, facts: F, engine: E, docs: D, flow: W } = window.LA;
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
monthly_wage / wages_owed_amount: 数字（元）
signed_contract: yes|no|later（later=入职很久后补签）
termination_form: written|chat|oral
termination_reason: none|misconduct|incompetence|layoff|other
wages_owed: yes|no
signed_exit_doc: yes|no（离开时是否签过离职协议/申请等文件）
hr_role: yes|no（职务是否负责人事或属于管理层）
refused_to_sign: yes|no（公司是否书面通知签合同而本人没签）
company_name: 字符串
labor_proof: social|payroll|badge|chat|none（没签合同时，能证明劳动关系的最有力材料：社保记录 / 单位账户发的工资流水 / 工牌工作证或考勤 / 只有工作群聊天 / 都没有）
other_issues: 数组，可含 overtime|annual_leave|social_insurance|work_injury（受伤、工伤、职业病）|platform_work（外卖骑手、网约车等平台接单，或外包）|dispatch（劳务派遣）|subcontract（挂靠、包工头、违法转包分包）`;

  async function extract(text, facts, currentSlot) {
    const sample = await samplePromise;
    if (sample) {
      const prompt = `你是劳动争议咨询助手，只做一件事：从劳动者的话里抽取事实，输出 JSON。
今天是 ${today()}。相对时间（上个月、去年）换算成具体日期。
只输出用户明确说了或能直接推出的字段，没提到的不要输出，不要猜。不要给法律结论，不要算金额。
${currentSlot ? `刚才问用户的问题是：「${currentSlot.ask}」（对应字段 ${currentSlot.key}）。\n` : ''}已知事实：${JSON.stringify(facts)}
字段与取值：
${SLOT_SCHEMA}
输出格式：{"facts": {...}}

用户说：${text}`;
      try {
        const r = await sample.json(prompt, { modelTier: 'quick' });
        model.status = 'Claude';
        if (r && typeof r === 'object') return { facts: clean(r.facts || {}), by: 'model' };
      } catch (e) {
        if (e && e.code === 'not_granted') { model.ok = false; model.status = '关键词版（你没有授权使用 Claude）'; }
      }
    }
    const kw = F.keywordExtract(text, today());
    const city = findCity(text);
    if (city) kw.city = city;
    if (currentSlot && !kw[currentSlot.key]) Object.assign(kw, directAnswer(currentSlot, text));
    return { facts: kw, by: 'keyword' };
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

  async function draftReasons(st, claims) {
    const fallback = templateReasons(st, claims);
    const sample = await samplePromise;
    if (!sample) return fallback;
    // 只给模型用户确认过的事实；不给金额，也不许它写金额（金额只在「仲裁请求」里由代码填）
    const facts = Object.fromEntries(Object.entries(st.facts).filter(([k]) => !(st.pending || {})[k] && !['monthly_wage', 'wages_owed_amount', 'monthly_overtime'].includes(k)));
    const details = rebuttalTexts(st);
    const prompt = `请为劳动仲裁申请书润色「事实与理由」部分。要求：第三人称称「申请人」「被申请人」；按时间顺序陈述事实；只使用下面给出的事实，不要补充任何没给出的事实、日期或数字；不要写任何金额；不要做法律定性，不要写法条；最后一段写「为维护申请人的合法权益，特依法申请仲裁，请求支持申请人的仲裁请求。」；300 字以内；只输出正文。
事实：${JSON.stringify(facts)}
仲裁请求事项：${claims.map(c => c.title).join('；')}${details.length ? '\n申请人自己补充的细节（可以用，但不要写其中的金额）：' + details.join('；') : ''}`;
    try {
      const r = await sample(prompt, { cache: false });
      const text = (r.text || '').trim();
      // 代码校验：出现金额或事实里没有的日期，就不用模型稿，退回代码模板
      return text && !W.checkReasons(text, st.facts, details).length ? text : fallback;
    } catch (e) { return fallback; }
  }

  // 质证环节当事人写下的补充细节
  function rebuttalTexts(st) { return Object.values(st.rebuttals || {}).map(t => String(t || '').trim()).filter(Boolean); }

  function templateReasons(st, claims) {
    const f = st.facts, L = labelOf;
    const parts = [];
    parts.push(`申请人于 ${f.start_date || '____'} 入职被申请人${f.company_name ? '（' + f.company_name + '）' : ''}，月工资约 ${f.monthly_wage ? E.yuan(f.monthly_wage) : '____'} 元。`);
    if (f.signed_contract) parts.push(`双方${f.signed_contract === 'yes' ? '签订了' : f.signed_contract === 'later' ? '于 ' + (f.contract_signed_date || '____') + ' 补签了' : '未签订'}书面劳动合同。`);
    if (f.separation === 'company_terminated') parts.push(`${f.end_date || '____'}，被申请人以${{ written: '书面', chat: '微信或短信', oral: '口头' }[f.termination_form] || '____'}方式通知申请人解除劳动关系，${f.termination_reason === 'none' ? '未说明任何理由' : '理由为' + (L('termination_reason', f.termination_reason) || '____')}。`);
    for (const t of rebuttalTexts(st)) parts.push(/[。！？]$/.test(t) ? t : t + '。');
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
      id: 'c' + Date.now(), updated: null, page: 'P1', facts: {}, manual: {}, uncertain: {}, pending: {}, rebuttals: {}, rebutted: [],
      chat: [{ role: 'ai', text: GREETING }], evidence: { labor_relation: [], wage: [], termination: [] }, selected: [], recognized: [], avgWage: null, minWage: null, regAvgWage: null, regMinWage: null,
      app: { applicant: { name: '', gender: '', id_no: '', address: '', phone: '' }, respondent: { name: '', address: '', legal_rep: '', credit_code: '' }, reasons: '', step: 1 },
    };
  }

  const GREETING = '你好，我是劳动仲裁助手。先用一两句话说说发生了什么：在哪个城市上班、干了多久、工资多少、公司做了什么。说不全也没关系，我再接着问。';
  const PAGES = [
    { id: 'P1', name: '对话' }, { id: 'P2', name: '分析' }, { id: 'P3', name: '测算' },
    { id: 'P4', name: '报告' }, { id: 'P5', name: '证据' }, { id: 'P6', name: '申请书' },
  ];

  createApp({
    setup() {
      const st = reactive(blankCase());
      const ui = reactive({ reply: '', busy: false, drawer: false, cases: loadCases(), tab: 'detail', missing: [], rebutResult: null, rebutPicked: null, rebutBefore: null, exportText: '', editing: false, toast: '' });

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
      const arbitration = computed(() => st.facts.city ? `${st.facts.city}${/市|州|盟|地区|林区$/.test(st.facts.city) ? '' : '市'}劳动人事争议仲裁委员会` : '');

      function persist() {
        st.updated = new Date().toISOString();
        const list = loadCases().filter(c => c.id !== st.id);
        list.unshift(JSON.parse(JSON.stringify(st)));
        saveCases(list.slice(0, 20));
        ui.cases = loadCases();
      }
      watch(st, persist, { deep: true });

      function merge(found) {
        const changed = [];
        for (const [k, v] of Object.entries(found)) {
          if (st.manual[k]) continue;
          if (k === 'other_issues') { st.facts.other_issues = [...new Set([...(st.facts.other_issues || []), ...v])]; continue; }
          if (st.facts[k] !== v) { st.facts[k] = v; changed.push(k); if (W.CALC_KEYS.includes(k)) st.pending[k] = true; }
        }
        return changed;
      }

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
        const r = await extract(text, st.facts, slot);
        // 已有城市时，只有在问城市这一步才改（避免公司名里的地名把城市覆盖掉）
        if (st.facts.city && !(slot && slot.key === 'city')) delete r.facts.city;
        const changed = merge(r.facts);
        ui.busy = false;
        if (first) st.chat.push({ role: 'ai', text: changed.length ? `我先复述一下听懂的：${recapOf(changed)}。` : '好的，我们一个个来。' });
        else if (changed.length) st.chat.push({ role: 'ai', text: `记下了：${recapOf(changed)}。` });
        else if (slot) { st.uncertain[slot.key] = (st.uncertain[slot.key] || 0) + 1; st.chat.push({ role: 'ai', text: '这个我没太读懂，换个方式问。' }); }
        askNext(); scrollChat();
      }

      function pick(slotKey, opt) {
        st.chat.push({ role: 'user', text: opt.label });
        st.facts[slotKey] = opt.value; delete st.pending[slotKey];
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
        st.manual[k] = true;
      }
      // 用户核对后确认：模型读出的计算参数从「待确认」转为「已确认」，之后才出金额
      const pendingKeys = computed(() => W.unconfirmed(st.facts, st.pending));
      function confirmParams() { st.pending = {}; }
      const gate = computed(() => W.gates({ facts: st.facts, pending: st.pending, selected: st.selected, conflicts: conflicts.value, chosen: chosen.value, started: st.chat.some(m => m.role === 'user') }));

      function toAnalysis(confirm) {
        if (confirm === true) confirmParams();
        // 默认勾选：先按离职方式对应的补偿类型（2N / N / N+代通知金），再补上不互斥的其他请求；恢复劳动关系不默认勾
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
      async function recognize(kind, tag, slot, list) {
        files[slot] = [...(files[slot] || []), ...list.map(f => ({ name: f.name, url: URL.createObjectURL(f) }))];
        const imgs = imgCaps.ok ? list.filter(f => imgCaps.accept.split(',').includes(f.type)).slice(0, imgCaps.max) : [];
        const rec = { tag, kind, at: new Date().toISOString(), filled: [], conflicts: [], note: '', busy: true };
        st.recognized.unshift(rec);
        const r = st.recognized[0];
        if (!imgs.length) {
          r.busy = false;
          r.note = imgCaps.ok ? '已附上。PDF 暂时不能识别，请上传照片或截图。' : '已附上。当前环境不能识别图片，相关信息请手动填写。';
          return;
        }
        try {
          const sample = await samplePromise;
          const data = await sample.json(D.prompt(kind, tag), { images: imgs });
          if (data && data.doc_ok === false) r.note = `这张看起来不像「${tag}」，请确认上传的文件。`;
          const before = Object.fromEntries(W.CALC_KEYS.map(k => [k, st.facts[k]]));
          const out = D.apply(kind, data, { facts: st.facts, manual: st.manual, applicant: st.app.applicant, respondent: st.app.respondent });
          for (const k of W.CALC_KEYS) if (st.facts[k] !== before[k]) st.pending[k] = true;
          r.filled = out.filled; r.conflicts = out.conflicts;
          if (out.wage) r.note = `按 ${out.wage.from} 至 ${out.wage.to} 共 ${out.wage.months} 个月的应发工资，平均月工资 ${E.yuan(out.wage.value)} 元（代码计算）。`;
          if (W.CALC_KEYS.some(k => st.pending[k])) r.note = (r.note ? r.note + ' ' : '') + '读到的参数要你在「测算」页确认后才会用来算金额。';
          if (out.reason) r.note = (r.note ? r.note + ' ' : '') + `材料上写的解除理由：「${out.reason}」`;
          if (!out.filled.length && !out.conflicts.length && !r.note) r.note = '没有读到新的信息。';
        } catch (e) {
          r.note = e && e.code === 'not_granted' ? '你没有授权使用 Claude，没法识别，相关信息请手动填写。' : '识别没有成功，可以换一张清楚点的照片再试。';
        }
        r.busy = false;
      }
      // 页面跳转由 flow.gates 决定，卡住时说明缺什么
      // ---------- 质证：对方可能这样说，当事人回应、补充细节，再重新分析 ----------
      // 回应的大白话照样走「模型抽事实 → 代码合并（计算参数待确认）→ 代码重算」，前后对比由代码给出
      async function submitRebuttals() {
        const todo = Object.entries(st.rebuttals).filter(([k, t]) => String(t || '').trim() && !st.rebutted.includes(k + '|' + t));
        if (!todo.length && !ui.rebutPicked) { flash('先写一条回应，或点选上面的选项'); return; }
        const { before, beforeIds } = ui.rebutBefore || snapshot();
        ui.busy = true;
        const changed = [];
        for (const [k, t] of todo) {
          const r = await extract(t, st.facts, null);
          if (st.facts.city) delete r.facts.city;
          changed.push(...merge(r.facts));
          st.rebutted.push(k + '|' + t);
        }
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
        ui.rebutResult = { recap: recapOf([...new Set([...changed, ...(ui.rebutPicked || [])])]), diffs };
        ui.rebutPicked = null; ui.rebutBefore = null;
      }
      function snapshot() {
        return { before: Object.fromEntries(chosen.value.map(c => [c.id, { tier: c.tier, amount: c.calc && c.calc.amount }])), beforeIds: analysis.value.claims.map(c => c.id) };
      }
      function rebutPick(slot, value) {
        if (!ui.rebutBefore) ui.rebutBefore = snapshot();
        editFact(slot, value);
        ui.rebutPicked = [...new Set([...(ui.rebutPicked || []), slot])];
      }

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
      const reasonProblems = computed(() => W.checkReasons(st.app.reasons, st.facts, rebuttalTexts(st)));
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
        st.app.reasons = await draftReasons(st, chosen.value);
        ui.busy = false;
      }
      watch(() => st.page, p => { if (p === 'P6' && !st.app.respondent.name && st.facts.company_name) st.app.respondent.name = st.facts.company_name; });

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
      function table(rows) {
        const border = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(e => `<w:${e} w:val="single" w:sz="4" w:color="000000"/>`).join('') + '</w:tblBorders>';
        return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${border}</w:tblPr>` + rows.map((r, i) => '<w:tr>' + r.map(c => `<w:tc><w:p>${run(c, i === 0)}</w:p></w:tc>`).join('') + '</w:tr>').join('') + '</w:tbl>';
      }
      async function docx(blocks) {
        const body = blocks.map(b => b.table ? table(b.table) : para(b)).join('');
        const zip = new JSZip();
        zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
        zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
        zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
        return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      }
      function evidenceDoc() {
        const rows = [['序号', '证据名称', '证明目的', '页数']];
        evidenceGroups.value.filter(g => st.evidence[g.group].length).forEach((g, i) => rows.push([String(i + 1), st.evidence[g.group].join('、'), g.purpose, '']));
        return [{ text: '证据目录', bold: true, size: 36, align: 'center' }, { table: rows }, { text: '' }, { label: '提交人：', text: st.app.applicant.name }, { text: today() }];
      }
      function applicationDoc() {
        const a = st.app.applicant, r = st.app.respondent;
        return [
          { text: '劳动人事争议仲裁申请书', bold: true, size: 36, align: 'center' },
          { label: '申请人：', text: `${a.name}，${a.gender}，身份证号 ${a.id_no}，住址 ${a.address}，电话 ${a.phone}` },
          { label: '被申请人：', text: `${r.name}，住所 ${r.address}，法定代表人 ${r.legal_rep || '（待补）'}，统一社会信用代码 ${r.credit_code || '（待补）'}` },
          { label: '仲裁请求：', text: '' },
          ...requestLines().map((l, i) => ({ text: `${i + 1}. ${l}；` })),
          { label: '事实与理由：', text: '' },
          ...st.app.reasons.split('\n').filter(Boolean).map(t => ({ text: t })),
          { text: '此致' }, { text: arbitration.value },
          { text: `申请人：${a.name}`, align: 'right' }, { text: today(), align: 'right' },
        ];
      }
      async function save(filename, blocks) {
        const dl = window.claude && window.claude.use ? await window.claude.use('downloads').catch(() => null) : null;
        if (dl && window.JSZip) {
          try { await dl.save({ filename, data: await docx(blocks) }); flash('已交给浏览器保存'); return; }
          catch (e) { if (e && (e.code === 'declined' || e.code === 'rate_limited')) return; }
        }
        ui.exportText = blocks.map(b => b.table ? b.table.map(r => r.join('\t')).join('\n') : (b.label || '') + b.text).join('\n');
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
        answer, pick, notSure, editFact, toAnalysis, pendingKeys, confirmParams, gate, submitRebuttals, rebutPick, reasonProblems, appFormat, W, toggleClaim, toggleEvidence, go, newCase, openCase, appNext, exportApp, draft, requestLines,
        save, evidenceDoc, applicationDoc, examples, useExample, fillSample, tierClass, statusClass, pct, display, labelOf, today };
    },
  }).mount('#app');
})();
