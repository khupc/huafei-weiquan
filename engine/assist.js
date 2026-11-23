// 应用层 AI 辅助：问答助手、证据时间线、录音关键句、风险提醒。
// 三明治原则不变：模型只做理解和白话表达；金额、日期计算、能否主张全由代码给出，模型输出都要过这里的校验。
(function (root) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const R = isNode ? require('../rules/rules.js') : root.LA.rules;

  // ---------- 问答助手的知识库 ----------
  // 只放已审校的内容：法条库（rules.js，review=已核条号）+ 程序时间线（procedure.js 同源）+ 少量常见问题。
  // 常见问题里还没经律师线程确认的标 pending，回答时会注明「待律师确认」。
  const FAQ = [
    { id: 'FAQ-fee', q: '劳动仲裁要花钱吗', a: '劳动仲裁不收费，仲裁经费由财政保障（调解仲裁法第 53 条）。打印、复印、邮寄等是自己的开销。', review: 'pending' },
    { id: 'FAQ-lawyer', q: '要不要请律师', a: '不是必须。可以自己申请，也可以委托律师或其他代理人，委托要交授权委托书，写明委托事项和权限（调解仲裁法第 24 条）。', review: 'ok' },
    { id: 'FAQ-duration', q: '仲裁要多久', a: '收到申请 5 个工作日内决定是否受理；受理之日起 45 日内结案，经批准可延长不超过 15 日（调解仲裁法第 43 条）。', review: 'ok' },
    { id: 'FAQ-appeal', q: '不服裁决怎么办', a: '非终局裁决双方都可以在收到裁决书 15 日内向法院起诉；一裁终局的，劳动者不服可以 15 日内起诉，公司只能 30 日内向中级法院申请撤销（调解仲裁法第 47–49 条）。', review: 'ok' },
    { id: 'FAQ-employed', q: '还在职能不能申请', a: '可以。在职期间追讨欠薪不受 1 年时效限制，离职后要在 1 年内申请（调解仲裁法第 27 条）。', review: 'ok' },
    { id: 'FAQ-evidence-company', q: '证据都在公司手里怎么办', a: '与争议有关、由公司掌握管理的证据，由公司提供；公司不提供的，要承担不利后果（调解仲裁法第 6 条）。辞退、减少报酬、计算工作年限的争议，由公司负举证责任（最高法劳动争议解释（一）第 44 条）。', review: 'ok' },
    { id: 'FAQ-hearing', q: '开庭不去会怎样', a: '必须到庭。无正当理由不到庭的，可以按撤回申请处理，而且不能再就同一事项申请；确实去不了，要在开庭 3 日前申请延期（办案规则第 38、39 条）。', review: 'ok' },
    { id: 'FAQ-enforce', q: '赢了公司不给钱怎么办', a: '裁决生效后公司不履行的，向法院申请强制执行（调解仲裁法第 51 条）。', review: 'ok' },
    { id: 'FAQ-mediation', q: '一定要先调解吗', a: '调解不是必经程序，可以直接申请仲裁（调解仲裁法第 5 条）。有的地方窗口会建议先调解，可以拒绝。', review: 'ok' },
    { id: 'FAQ-recording', q: '偷偷录的音能用吗', a: '自己参与的对话录音，一般可以作为证据，但不能用侵害他人合法权益或违反法律禁止性规定的方法取得。要保留原始文件和手机，开庭时附文字稿。', review: 'pending' },
  ];

  function kb(region) {
    const out = [];
    for (const [id, l] of Object.entries(R.LAWS)) if (l.review === R.OK) out.push({ id, title: l.name, text: l.gist, review: 'ok' });
    for (const f of FAQ) out.push({ id: f.id, title: f.q, text: f.a, review: f.review });
    if (region) {
      const f = region.application_format || {};
      const t = [f.jurisdiction, f.online_note, f.pre_mediation, f.submit_note, f.mail].filter(Boolean).join(' ');
      if (t) out.push({ id: 'REGION', title: `${region.city}的提交规则`, text: t, review: 'ok' });
    }
    return out;
  }

  function qaPrompt(question, entries, ctx, history) {
    return `你是劳动仲裁助手里的问答功能，回答普通劳动者的问题。规则：
1. 只依据下面的「知识库」和「这个案子的情况」回答，用大白话，150 字以内。
2. 知识库和案子情况里都没有的，直说「这个我这里没有可靠的依据」，建议拨打当地 12333 或咨询律师，不要自己发挥。
3. 不要给出任何新的金额或天数。案子里的金额只能原样引用「这个案子的情况」里给的数字。
4. 不改案子数据，不替用户做决定。
5. 引用了哪些知识库条目，把 id 放进 sources。
知识库：${JSON.stringify(entries.map(e => ({ id: e.id, title: e.title, text: e.text })))}
这个案子的情况：${JSON.stringify(ctx)}
之前的对话：${JSON.stringify((history || []).slice(-6))}
用户的问题：${question}
只输出 JSON：{"answer": "...", "sources": ["id"]}`;
  }

  // 模型回答里出现的金额（数字 + 元/万）必须在给它的材料里出现过，否则判为编造
  const MONEY = /(\d[\d,，.]*)\s*(万元|万|元|块)/g;
  const norm = s => String(s).replace(/[,，\s]/g, '');
  // 按数值比：「3 万元」= 30000，必须等于材料里出现过的某个金额
  const valueOf = m => { const v = parseFloat(norm(m[1])); return /万/.test(m[2]) ? Math.round(v * 10000) : v; };
  function moneyOutside(text, allowed) {
    const pool = new Set([...String(allowed || '').matchAll(MONEY)].map(valueOf));
    const bad = [];
    for (const m of String(text || '').matchAll(MONEY)) if (!pool.has(valueOf(m))) bad.push(m[0]);
    return bad;
  }
  function checkAnswer(r, entries, ctx) {
    const answer = r && typeof r.answer === 'string' ? r.answer.trim() : '';
    if (!answer) return { ok: false, why: 'empty' };
    const allowed = JSON.stringify(entries) + JSON.stringify(ctx);
    if (moneyOutside(answer, allowed).length) return { ok: false, why: 'money' };
    const ids = new Set(entries.map(e => e.id));
    const sources = (Array.isArray(r.sources) ? r.sources : []).filter(id => ids.has(id));
    const pending = sources.filter(id => (entries.find(e => e.id === id) || {}).review === 'pending');
    return { ok: true, answer, sources, pending };
  }

  // ---------- 证据时间线 ----------
  // recognized：每份材料的识别结果，doc_date 由模型从材料上读出（YYYY-MM-DD 或 YYYY-MM），读不到的放最后
  function evidenceTimeline(recognized) {
    const ok = d => typeof d === 'string' && /^\d{4}-\d{2}(-\d{2})?$/.test(d);
    return (recognized || []).filter(r => !r.busy && !r.dup)
      .map(r => ({ date: ok(r.doc_date) ? r.doc_date : null, tag: r.tag, note: r.note, name: r.file }))
      .sort((a, b) => (a.date || '9999') < (b.date || '9999') ? -1 : (a.date || '9999') > (b.date || '9999') ? 1 : 0);
  }

  // ---------- 录音关键句 ----------
  function transcriptPrompt(text, facts) {
    return `下面是劳动者提供的一段录音的文字稿（可能来自手机或微信的转文字，有错字）。请摘出对劳动仲裁有用的关键句，最多 8 句，每句必须是文字稿里的原话，一个字都不要改。
每句说明：speaker（说话人，看不出写「不确定」）、shows（这句能说明什么事实，20 字以内，不写金额，不做法律定性）。
重点找：谁提出让劳动者走、怎么说的（如「明天不用来了」）、有没有给理由、工资欠付、有没有签合同、入职和离职时间。
已知事实：${JSON.stringify(facts || {})}
文字稿：${text}
只输出 JSON：{"quotes": [{"quote": "原话", "speaker": "...", "shows": "..."}]}`;
  }
  const squash = s => String(s || '').replace(/[\s，。,.!！?？、：:；;“”"「」'‘’…—-]/g, '');
  function checkQuotes(r, transcript) {
    const t = squash(transcript);
    return (r && Array.isArray(r.quotes) ? r.quotes : [])
      .filter(q => q && typeof q.quote === 'string' && squash(q.quote).length >= 2 && t.includes(squash(q.quote)))
      .slice(0, 8)
      .map(q => ({ quote: q.quote.trim(), speaker: String(q.speaker || '不确定').slice(0, 10), shows: /\d\s*(元|万|块)/.test(q.shows || '') ? '' : String(q.shows || '').slice(0, 40) }));
  }

  // ---------- 风险提醒 ----------
  // 代码风险：时效、证据档位、待确认的冲突。只用模板化的大白话，不调模型。
  function codeRisks(x) {
    const out = [];
    const lim = (x.eligibility && x.eligibility.items || []).find(i => i.label === '时效');
    if (lim && lim.status === 'risk') out.push({ level: 'high', title: lim.daysLeft != null && lim.daysLeft >= 0 ? `离申请截止只剩 ${lim.daysLeft} 天` : '可能已经过了 1 年申请期', text: lim.note });
    for (const a of x.asks || []) out.push({ level: 'high', title: `「${a.label}」有两个说法`, text: `${(a.values || []).map(v => `${x.display ? x.display(a.key, v.v) : v.v}（${v.source}）`).join(' / ')}。请在页面上方选以哪个为准，选错会影响金额或能不能主张。` });
    for (const c of x.claims || []) {
      if (c.tier === '需补证') out.push({ level: 'mid', title: `${c.title}：还差一步`, text: (c.toSolid || []).length ? `${c.toSolid.join('；')}。没有这些，仲裁员可能不认。` : '关键证据还没勾选或上传，先补上再交。' });
      if (c.tier === '有争议') out.push({ level: 'mid', title: `${c.title}：有争议点`, text: (c.disputes || []).join('；') });
    }
    return out;
  }
  function riskPrompt(record) {
    return `你在帮劳动者检查仲裁材料里的风险。下面是他说过的话（user_words）、上传材料读到的内容（materials）和已确认的事实（confirmed_facts）。
请只找「前后说法对不上」或「证据和说法对不上」的地方，最多 5 条。每条要写出对不上的两处原话或材料内容（a 和 b，必须从下面的记录里原样摘取），以及用大白话说明为什么要紧、建议怎么处理（tip，40 字以内）。
不要写金额，不要判断能拿多少钱，没有矛盾就输出空数组，不要硬凑。
记录：${JSON.stringify(record)}
只输出 JSON：{"risks": [{"a": "...", "b": "...", "tip": "..."}]}`;
  }
  function checkRisks(r, record) {
    const pool = squash(JSON.stringify(record));
    return (r && Array.isArray(r.risks) ? r.risks : [])
      .filter(x => x && x.a && x.b && x.tip && squash(x.a) !== squash(x.b) && pool.includes(squash(x.a)) && pool.includes(squash(x.b)) && !/\d\s*(元|万|块)/.test(x.tip))
      .slice(0, 5)
      .map(x => ({ a: String(x.a).slice(0, 80), b: String(x.b).slice(0, 80), tip: String(x.tip).slice(0, 80) }));
  }

  // ---------- 开庭准备 ----------
  // 输入的记录不含金额；输出每题的回答要点也不许有金额，提到的证据必须是清单里有的
  function hearingPrompt(record, defenses, evidence) {
    return `你在帮劳动者准备劳动仲裁开庭。根据案件记录，列出仲裁员最可能问他的问题，最多 8 个，按开庭顺序（身份和入职 → 工作和工资 → 怎么离职的 → 各项请求 → 证据）。
每题写：q（问题，口语）；why（仲裁员为什么问，20 字以内）；points（回答要点 1–3 条，每条 30 字以内，只用记录里有的事实，记录里没有的写「如实说明，记不清就说记不清」）；evidence（回答时可以出示的证据，只能从证据清单里选）。
对方可能的说法也要准备：${JSON.stringify(defenses)}
不要写金额，不要编日期，不做法律定性。
证据清单：${JSON.stringify(evidence)}
案件记录：${JSON.stringify(record)}
只输出 JSON：{"items": [{"q": "...", "why": "...", "points": ["..."], "evidence": ["..."]}]}`;
  }
  const hasMoney = t => /\d\s*(元|万|块)/.test(String(t || ''));
  function checkHearing(r, evidence, okText) {
    const ev = new Set(evidence || []);
    return (r && Array.isArray(r.items) ? r.items : [])
      .filter(x => x && typeof x.q === 'string' && x.q.trim())
      .slice(0, 8)
      .map(x => ({
        q: x.q.trim().slice(0, 60),
        why: hasMoney(x.why) ? '' : String(x.why || '').slice(0, 40),
        points: (Array.isArray(x.points) ? x.points : []).map(String).filter(t => t.trim() && !hasMoney(t) && (!okText || okText(t))).slice(0, 3).map(t => t.slice(0, 60)),
        evidence: (Array.isArray(x.evidence) ? x.evidence : []).filter(e => ev.has(e)),
      }));
  }

  // ---------- 协商参考 ----------
  // 金额只能来自 money（代码算好的主张值、保守值、各项金额）；模型只写怎么说
  function negotiationPrompt(record, money) {
    return `劳动者想先和公司协商，再决定是否仲裁。请帮他准备：points（可以提的要求和理由，3–5 条，每条 40 字以内）；script（开场怎么说，100 字以内，语气平和、坚定）；cautions（谈的时候注意什么，2–3 条，30 字以内）。
金额只能原样使用下面「代码算好的金额」里的数字，不要自己算、不要给折扣比例、不要建议接受多少。
代码算好的金额：${JSON.stringify(money)}
案件记录：${JSON.stringify(record)}
只输出 JSON：{"points": ["..."], "script": "...", "cautions": ["..."]}`;
  }
  function checkNegotiation(r, money) {
    if (!r) return null;
    const allowed = JSON.stringify(money);
    const clean = t => typeof t === 'string' && t.trim() && !moneyOutside(t, allowed).length && !/[折%％]|成左右/.test(t);
    const points = (Array.isArray(r.points) ? r.points : []).filter(clean).slice(0, 5);
    const cautions = (Array.isArray(r.cautions) ? r.cautions : []).filter(clean).slice(0, 3);
    const script = clean(r.script) ? r.script.trim().slice(0, 200) : '';
    if (!points.length && !script) return null;
    return { points, script, cautions };
  }

  const api = { hearingPrompt, checkHearing, negotiationPrompt, checkNegotiation, FAQ, kb, qaPrompt, moneyOutside, checkAnswer, evidenceTimeline, transcriptPrompt, checkQuotes, codeRisks, riskPrompt, checkRisks };
  if (isNode) module.exports = api;
  else root.LA = Object.assign(root.LA || {}, { assist: api });
})(this);
