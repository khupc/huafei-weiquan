const { createApp } = Vue;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

function anonId() {
  let id = store.get('anon_id');
  if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()); store.set('anon_id', id); }
  return id;
}

async function api(method, path, body) {
  const res = await fetch('/api/cases' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '出了点问题，请稍后再试');
  return data;
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');  // WeChat webview fallback
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  return Promise.resolve();
}

createApp({
  data: () => ({
    view: null, chat: [], draft: '', quickReplies: null, busy: false, error: '',
    editing: false, facts: {}, choice: { selected: [], custom: '' }, showCallForm: false, call: {}, body: '',
    showSurvey: false, surveyDone: false, survey: { result: null, blocker_tag: null },
    RESULTS: { FULL_RESOLVED: '全额解决', PARTIAL_RESOLVED: '部分解决', ABANDONED: '放弃' },
    BLOCKERS: { UNCLEAR_GUIDE: '听不懂提示', AGENT_OFF_SCRIPT: '客服不按套路走', FORM_HARD: '申诉网页不会填', TOO_TIRED: '懒得弄了' },
  }),
  computed: { card() { return (this.view && this.view.card) || {}; } },
  async mounted() {
    const id = store.get('case_id');
    if (id) { try { return this.apply(await api('GET', '/' + id)); } catch {} }
    await this.restart();
  },
  methods: {
    apply(v) {
      this.view = v;
      this.editing = false;
      if (v.state === 'NODE_1_CONFIRM_CARD') this.facts = { ...v.card };
      if (v.state === 'NODE_1_ADVICE') {
        const mine = v.card.demands.findIndex(d => d.from_user);
        this.choice = { selected: mine >= 0 ? [mine] : [], custom: '' };
      }
      if (v.state === 'NODE_3_APPEAL') this.body = v.card.modules.find(m => m.key === 'complaint_body').text;
      window.scrollTo(0, 0);
    },
    async run(fn) {
      this.busy = true; this.error = '';
      try { return await fn(); } catch (e) { this.error = e.message; } finally { this.busy = false; }
    },
    async restart() {
      const v = await api('POST', '', { user_anon_id: anonId() });
      store.set('case_id', v.case_id);
      Object.assign(this, { chat: [], draft: '', quickReplies: null, showSurvey: false, surveyDone: false, survey: { result: null, blocker_tag: null } });
      this.apply(v);
    },
    path(p = '') { return '/' + this.view.case_id + p; },
    send(text, quickReply, label) {
      return this.run(async () => {
        this.chat.push({ from: 'me', text: label || text });
        this.draft = '';
        const v = await api('POST', this.path('/messages'), { text, quick_reply: quickReply || null });
        this.quickReplies = v.quick_replies || null;
        if (v.ask) { this.chat.push({ from: 'bot', text: v.ask }); this.view = v; } else this.apply(v);
      });
    },
    upload(e) {
      const file = e.target.files[0]; if (!file) return;
      return this.run(async () => {
        const fd = new FormData(); fd.append('file', file);
        const res = await fetch('/api/cases' + this.path('/screenshot'), { method: 'POST', body: fd });
        const v = await res.json();
        if (!res.ok) throw new Error(v.detail || '上传失败');
        const got = v.screenshot_fields && Object.keys(v.screenshot_fields).length;
        this.chat.push({ from: 'bot', text: got ? '截图里的信息已经记下了。' : '暂时没能从截图里读出信息，麻烦用文字说一下。' });
      });
    },
    act(action, body) { return this.run(async () => this.apply(await api('POST', this.path('/' + action), body))); },
    pick(key, value) {
      this.facts[key] = value;
      return this.run(async () => { const v = await api('PUT', this.path('/facts'), { [key]: value }); this.view = v; });
    },
    saveFacts() {
      const f = this.facts;
      const changes = { summary: f.summary, amount: f.amount === '' ? null : f.amount, duration_or_time: f.duration_or_time,
        city: f.city, expectation: f.expectation, prior_contact_status: f.prior_contact_status, ticket_id: f.ticket_id, agent_id: f.agent_id, call_date: f.call_date };
      return this.run(async () => this.apply(await api('PUT', this.path('/facts'), changes)));
    },
    backToConfirm() { return this.run(async () => this.apply(await api('PUT', this.path('/facts'), {}))); },
    confirmCard() {
      // the city is a free-text field: save it together with the confirm, not on blur
      return this.run(async () => {
        if ((this.facts.city || '') !== (this.card.city || '')) await api('PUT', this.path('/facts'), { city: this.facts.city });
        this.apply(await api('POST', this.path('/confirm')));
      });
    },
    chooseDemands() { return this.act('demands', this.choice); },
    submitCall() {
      this.showCallForm = false;
      return this.act('call-result', { resolved: false, ...this.call });
    },
    copy(module, text) {
      copyText(text).then(() => { this.error = '已复制'; setTimeout(() => (this.error = ''), 1200); });
      api('POST', this.path('/copy'), { module, text }).catch(() => {});
    },
    quit() { this.survey.result = 'ABANDONED'; this.showSurvey = true; },
    submitSurvey() {
      return this.run(async () => {
        try { await api('POST', this.path('/survey'), this.survey); } catch (e) { if (!/填过/.test(e.message)) throw e; }
        this.surveyDone = true;
      });
    },
  },
}).mount('#app');
