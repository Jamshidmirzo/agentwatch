// Офис агентов: состояние, SSE, панели «Мой стол» / «Агент» / «Нанять», список.
// реалистичный офис, если скачаны текстуры (npm run assets); ?scene=classic — прежний
const wantClassic = new URLSearchParams(location.search).get('scene') === 'classic';
const hasAssets = !wantClassic && await fetch('/office/assets/tex/oak_veneer_01_diff.jpg', { method: 'HEAD', cache: 'no-store' }).then((r) => r.ok).catch(() => false);
const { Office, accentOf } = await import(hasAssets ? './real.js' : './scene.js');

let TOKEN = document.querySelector('meta[name="aw-token"]').content;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('aw.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('aw.' + k, JSON.stringify(v)); } catch {} },
};
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c; };
function ago(ts) {
  const s = Math.max(0, (Date.now() - (ts || Date.now())) / 1000);
  if (s < 45) return 'только что';
  if (s < 3600) return Math.round(s / 60) + ' мин';
  if (s < 86400) return Math.floor(s / 3600) + ' ч ' + Math.floor((s % 3600) / 60) + ' мин';
  return Math.floor(s / 86400) + ' д';
}

const MODE_LABEL = { default: 'Обычный', acceptEdits: 'Авто-правки', plan: 'План', auto: 'Auto', bypassPermissions: 'Без вопросов' };
const KIND_LABEL = { question: 'Вопрос', permission: 'Разрешение', plan: 'План', input: 'Ждёт ответа', done: 'Готово' };
const ENV_LABEL = { 'claude-vscode': 'VS Code', cli: 'Terminal', office: 'Офис' };
const EFFORT_LABEL = { low: 'Low', medium: 'Med', high: 'High', xhigh: 'XHigh', max: 'Max' };
const FALLBACK_MODELS = [{ value: 'opus', displayName: 'Opus' }, { value: 'sonnet', displayName: 'Sonnet' }, { value: 'haiku', displayName: 'Haiku' }];

const S = {
  snap: { agents: [], inbox: [], models: null, modes: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'], extModes: ['default', 'acceptEdits', 'plan', 'auto'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], hookInstalled: true },
  sheet: null, view: store.get('view', 'office'), sound: store.get('sound', true), notif: store.get('notif', false),
  seen: new Set(), first: true, busy: new Set(),
};

// ---------- API ----------
async function api(path, body, retried) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AW-Token': TOKEN }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 403 && j.error === 'token' && !retried) { // офис перезапустили — берём новый ключ и повторяем
    const t = await fetch('/api/token', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
    if (t?.token) { TOKEN = t.token; return api(path, body, true); }
  }
  if (!r.ok) throw new Error(j.error === 'token' ? 'Офис перезапустился — обновите страницу (⌘R)' : j.error || 'HTTP ' + r.status);
  return j;
}
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.classList.toggle('err', !!err); t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), err ? 4000 : 2200);
}

// ---------- офис ----------
let office = null;
try {
  office = new Office($('#stage'), {
    onAgent: (k) => openAgent(k), onDesk: () => openDesk(), onBubble: (k) => openForAgent(k),
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => office.setTheme(e.matches ? 'dark' : 'light'));
} catch (e) {
  console.error(e);
  S.view = 'list';
  setTimeout(() => toast('3D недоступен в этом браузере — показываю список', true), 300);
}
setTimeout(() => { const h = $('#hint'); if (h) h.style.opacity = '0'; }, 9000);

const agentByKey = (k) => S.snap.agents.find((a) => a.key === k);
// агент с другого компьютера: его флаги, модели и связь берём от той машины
const mach = (a) => (a?.machine ? (S.snap.machines || []).find((m) => m.id === a.machine) || { id: a.machine, name: a.machineName || 'другой компьютер', online: false } : null);
const inboxUrl = (id) => '/api/inbox/' + encodeURIComponent(id);
// отправить текст в саму сессию VS Code / Terminal — как будто напечатал пользователь
const canSay = (a) => { const M = mach(a); return (a.entrypoint === 'claude-vscode' || (a.entrypoint === 'cli' && (a.tty || M))) && (!M || M.online); };
const sayBox = (a, label, rows = 2) => canSay(a) ? `<div class="field"><label>${label}</label><textarea name="say-${esc(a.key)}" rows="${rows}" placeholder="Отправится в сессию как ваш запрос (⌘↩)"></textarea><div class="row"><button class="btn primary" data-act="say" data-key="${esc(a.key)}">Отправить</button></div></div>` : '';
const accent = (a) => accentOf(a?.project || '');

function deskEntries() {
  const ghost = (i) => ({ key: i.agentKey, project: (i.cwd || '').split('/').pop() || 'сессия', title: 'Сессия ' + (i.cwd || '').split('/').pop(), entrypoint: 'cli', kind: 'external', ghost: true });
  const out = S.snap.inbox.map((i) => ({ id: i.id, item: i, agent: agentByKey(i.agentKey) || ghost(i), at: i.createdAt }));
  const withItem = new Set(S.snap.inbox.map((i) => i.agentKey));
  for (const a of S.snap.agents) if (a.status === 'waiting' && !withItem.has(a.key)) out.push({ id: 'p:' + a.key, pseudo: true, agent: a, at: a.statusUpdatedAt });
  for (const a of S.snap.agents) if (a.report && a.status === 'idle') out.push({ id: 'r:' + a.key, report: true, agent: a, at: a.report.at });
  return out.sort((x, y) => (x.report ? 1 : 0) - (y.report ? 1 : 0) || (x.at || 0) - (y.at || 0));
}

// ---------- открыть / закрыть ----------
function openDesk(sel) { S.sheet = { type: 'desk', sel }; renderSheet(true); }
function openForAgent(key) {
  const a = agentByKey(key);
  if (a?.report && a.status !== 'waiting') { openDesk('r:' + key); office?.focusAgent(key); return; }
  const it = S.snap.inbox.find((i) => i.agentKey === key);
  openDesk(it ? it.id : 'p:' + key);
  office?.focusAgent(key);
}
function openAgent(key) { S.sheet = { type: 'agent', key }; renderSheet(true); office?.focusAgent(key); }
function closeSheet() { S.sheet = null; renderSheet(true); office?.highlight(null); }

// ---------- рендер: сохранение формы между обновлениями ----------
function saveForm(root) {
  const f = {};
  for (const el of $$('[name]', root)) f[el.name + '|' + (el.value ?? '')] = el.type === 'radio' || el.type === 'checkbox' ? el.checked : null;
  const vals = {};
  for (const el of $$('textarea[name], input[type=text][name]', root)) vals[el.name] = el.value;
  const a = document.activeElement;
  const body = $('.sh-body', root);
  return { f, vals, focus: a && root.contains(a) && a.name ? { name: a.name, s: a.selectionStart, e: a.selectionEnd } : null, scroll: body ? body.scrollTop : 0, atBottom: body ? body.scrollHeight - body.scrollTop - body.clientHeight < 30 : false };
}
function restoreForm(root, st) {
  for (const el of $$('input[type=radio][name], input[type=checkbox][name]', root)) { const k = el.name + '|' + el.value; if (k in st.f) el.checked = st.f[k]; }
  for (const el of $$('textarea[name], input[type=text][name]', root)) if (el.name in st.vals) el.value = st.vals[el.name];
  for (const el of $$('[data-reveal]', root)) if (st.vals['__open_' + el.dataset.reveal]) el.hidden = false;
  const body = $('.sh-body', root);
  if (body) body.scrollTop = st.keepBottom && st.atBottom ? body.scrollHeight : st.scroll;
  if (st.focus) { const el = $(`[name="${CSS.escape(st.focus.name)}"]`, root); if (el) { el.focus(); try { el.setSelectionRange(st.focus.s, st.focus.e); } catch {} } }
}

function renderSheet(force) {
  const el = $('#sheet');
  if (!S.sheet) { el.hidden = true; el.innerHTML = ''; el._sig = ''; return; }
  const v = S.sheet.type === 'desk' ? deskView() : agentView();
  if (!force && el._sig === v.sig) return;
  const st = el.hidden ? null : saveForm(el);
  if (st) for (const r of $$('[data-reveal]', el)) if (!r.hidden) st.vals['__open_' + r.dataset.reveal] = '1';
  el.innerHTML = v.html; el._sig = v.sig; el.hidden = false;
  if (st && el._for === S.sheet.type + (S.sheet.key || '')) restoreForm(el, { ...st, keepBottom: v.keepBottom });
  else if (v.keepBottom) { const b = $('.sh-body', el); if (b) b.scrollTop = b.scrollHeight; }
  el._for = S.sheet.type + (S.sheet.key || '');
  refreshAges();
}

const head = (title, sub, dot) => `<div class="sh-head">${dot ? `<span class="dot" style="background:${dot}"></span>` : ''}<div style="min-width:0"><h2>${title}</h2>${sub ? `<div class="sub">${sub}</div>` : ''}</div><button class="btn icon ghost x" data-act="close" title="Закрыть (Esc)">✕</button></div>`;

// ---------- «Мой стол» ----------
function deskView() {
  const entries = deskEntries();
  if (!entries.find((e) => e.id === S.sheet.sel)) S.sheet.sel = entries[0]?.id;
  const sel = S.sheet.sel;
  const n = entries.length, nD = entries.filter((e) => e.report).length, nW = n - nD;
  const sub = [nW ? `${nW} ${plural(nW, 'ждёт', 'ждут', 'ждут')} ответа` : '', nD ? `${nD} ${plural(nD, 'закончил', 'закончили', 'закончили')} работу` : ''].filter(Boolean).join(' · ');
  const h = head('Мой стол', sub || 'Входящих нет');
  if (!n) return { html: h + '<div class="sh-body"><div class="empty"><div class="big">☕️</div><b>Все при деле</b>Когда агенту понадобится ваш ответ или он закончит задачу, он подойдёт к вашему столу.</div></div>', sig: 'desk-empty' };
  const rows = entries.map((e) => {
    const a = e.agent || {}, kind = e.report ? 'done' : e.item ? e.item.kind : a.attention?.kind || 'input';
    const icon = kind === 'done' ? '✓' : kind === 'permission' ? '!' : kind === 'plan' ? '≡' : kind === 'input' ? '…' : '?';
    const cls = kind === 'done' ? 'green' : kind === 'permission' || kind === 'plan' ? 'amber' : kind === 'input' ? 'gray' : '';
    return `<button class="irow${e.id === sel ? ' sel' : ''}" data-act="sel" data-id="${e.id}"><span class="ic ${cls}">${icon}</span><span class="tx"><b>${esc(a.title || a.name || 'Агент')}</b><small>${esc(a.project || '')} · ${KIND_LABEL[kind] || 'Ждёт'}${e.pseudo ? ' · ответить в сессии' : ''}</small></span><span class="age" data-ago="${e.at}"></span></button>`;
  }).join('');
  const cur = entries.find((e) => e.id === sel);
  const detail = cur ? detailHTML(cur) : '';
  const sig = 'desk|' + sel + '|' + entries.map((e) => e.id + ':' + (e.agent?.title || '') + (e.report ? e.report.at : '')).join(',') + '|' + JSON.stringify(cur?.report ? cur.agent.report : null) + '|' + JSON.stringify(cur?.item?.input || cur?.agent?.attention || null) + '|' + S.snap.hookInstalled;
  return { html: h + `<div class="sh-body"><div class="ilist">${rows}</div>${detail}</div>`, sig };
}

function detailHTML(e) {
  const a = e.agent || {};
  const M = mach(a);
  const who = `${M && !M.online ? `<div class="banner">«${esc(M.name)}» не на связи — ответить сейчас нельзя</div>` : ''}<div class="row" style="margin:-2px 0 10px"><span class="chip" style="gap:6px"><i style="width:8px;height:8px;border-radius:50%;background:${accent(a)}"></i><b>${esc(a.project || '')}</b></span><span class="chip">${ENV_LABEL[a.entrypoint] || ''}${a.kind === 'hosted' ? ' ★' : ''}</span><span class="grow"></span>${a.ghost ? '' : `<button class="btn ghost" data-act="openagent" data-key="${esc(a.key)}">Агент →</button>`}</div>`;
  if (e.report) return who + reportHTML(a);
  if (e.pseudo) return who + pseudoHTML(a);
  const it = e.item;
  if (it.kind === 'question') return who + questionHTML(it);
  if (it.kind === 'plan') return who + planHTML(it);
  return who + permissionHTML(it);
}

function questionHTML(it) {
  const qs = it.input.questions || [];
  return qs.map((q, qi) => `
    <div class="card" data-q="${qi}">
      <div class="kicker"><span class="k">${esc(q.header || 'Вопрос')}</span>${q.multiSelect ? 'можно несколько' : ''}</div>
      <div class="qtext">${esc(q.question)}</div>
      ${(q.options || []).map((o, oi) => `<label class="opt"><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="q${qi}" value="${esc(o.label)}"><span class="n">${oi + 1}</span><div><b>${esc(o.label)}</b>${o.description ? `<span>${esc(o.description)}</span>` : ''}</div></label>`).join('')}
      <label class="opt other"><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="q${qi}" value="__other"><input type="text" name="q${qi}-other" data-other="${qi}" placeholder="Свой ответ…"></label>
    </div>`).join('') + `
    <div class="btnrow"><button class="btn primary big" data-act="answer" data-id="${it.id}" data-primary>Ответить</button><button class="btn big" data-act="deny" data-id="${it.id}" data-msg="не стал отвечать на вопрос">Пропустить</button></div>`;
}

const clip = (s, n = 4000) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '\n…' : s; };
function permissionHTML(it) {
  const i = it.input || {}, t = it.toolName;
  let body;
  if (t === 'Bash') body = `${i.description ? `<div class="qtext">${esc(i.description)}</div>` : ''}<pre class="mono">${esc(i.command)}</pre>`;
  else if (t === 'Edit' || t === 'MultiEdit') body = `<div class="qtext">Правка файла</div><div class="mono">${esc(i.file_path)}</div>${i.old_string != null ? `<pre class="mono diff-del">${esc(clip(i.old_string, 1500))}</pre><pre class="mono diff-add">${esc(clip(i.new_string, 1500))}</pre>` : ''}`;
  else if (t === 'Write') body = `<div class="qtext">Запись файла</div><div class="mono">${esc(i.file_path)}</div><pre class="mono diff-add">${esc(clip(i.content, 2500))}</pre>`;
  else if (t === 'WebFetch') body = `<div class="qtext">Открыть страницу</div><div class="mono">${esc(i.url)}</div>${i.prompt ? `<div class="note">${esc(i.prompt)}</div>` : ''}`;
  else if (t === 'WebSearch') body = `<div class="qtext">Поиск в интернете</div><div class="mono">${esc(i.query)}</div>`;
  else body = `<div class="qtext">${esc(t)}</div><pre class="mono">${esc(clip(JSON.stringify(i, null, 2)))}</pre>`;
  return `<div class="card"><div class="kicker"><span class="k amber">Разрешение</span>${esc(t)}</div>${body}</div>
    <div class="btnrow"><button class="btn primary big" data-act="allow" data-id="${it.id}" data-primary>Разрешить</button>${it.canAlways ? `<button class="btn big" data-act="always" data-id="${it.id}">Всегда в этой сессии</button>` : ''}<button class="btn danger big" data-act="reveal" data-target="deny-${it.id}">Отклонить…</button></div>
    <div class="field" data-reveal="deny-${it.id}" hidden><label>Почему (агент увидит)</label><textarea name="deny-${it.id}" rows="2" placeholder="Например: не трогай прод"></textarea><div class="row"><button class="btn danger" data-act="deny" data-id="${it.id}">Отклонить</button></div></div>`;
}

function planHTML(it) {
  return `<div class="card"><div class="kicker"><span class="k amber">План</span>агент закончил планирование</div><div class="md plan">${md(it.input.plan || '')}</div></div>
    <div class="btnrow"><button class="btn primary big" data-act="plan" data-mode="acceptEdits" data-id="${it.id}" data-primary>Одобрить · авто-правки</button><button class="btn big" data-act="plan" data-mode="default" data-id="${it.id}">Одобрить</button><button class="btn big" data-act="reveal" data-target="revise-${it.id}">Доработать…</button></div>
    <div class="field" data-reveal="revise-${it.id}" hidden><label>Что поправить в плане</label><textarea name="revise-${it.id}" rows="3"></textarea><div class="row"><button class="btn primary" data-act="revise" data-id="${it.id}">Отправить</button></div></div>`;
}

function reportHTML(a) {
  const r = a.report || {}, env = ENV_LABEL[a.entrypoint] || 'сессию', hosted = a.kind === 'hosted', M = mach(a);
  const next = !hosted ? sayBox(a, 'Что дальше') : hosted && a.controllable
    ? `<div class="field"><label>Новая задача или ответ</label><textarea name="msg-${esc(a.key)}" rows="2" placeholder="Что дальше?"></textarea><div class="row"><button class="btn" data-act="send" data-key="${esc(a.key)}">Отправить</button></div></div>`
    : '';
  return `<div class="card"><div class="kicker"><span class="k green">Готово</span>закончил <span data-ago="${r.at}"></span></div>
    ${r.prompt ? `<div class="ask-was">${esc(r.prompt)}</div>` : ''}
    <div class="md">${md(r.text || 'Агент закончил без текстового ответа.')}</div></div>
    <div class="btnrow"><button class="btn primary big" data-act="ack" data-key="${esc(a.key)}" data-primary>Посмотрел ✓</button>${hosted || M ? '' : `<button class="btn big" data-act="focus" data-key="${esc(a.key)}">Перейти в ${env}</button>`}</div>${next}`;
}

function pseudoHTML(a) {
  const att = a.attention || {}, t = a.transcript || {};
  let body;
  if (att.kind === 'question' && t.question) body = t.question.map((q) => `<div class="qtext">${esc(q.question)}</div>${(q.options || []).map((o) => `<div class="opt"><div><b>${esc(o.label)}</b>${o.description ? `<span>${esc(o.description)}</span>` : ''}</div></div>`).join('')}`).join('');
  else if (att.kind === 'plan' && t.planText) body = `<div class="md plan">${md(t.planText)}</div>`;
  else if (att.kind === 'permission') body = `<div class="qtext">${esc(att.text)}</div>`;
  else body = `<div class="md">${md(t.lastAssistantText || att.text || 'Ждёт ответа')}</div>`;
  const why = att.kind === 'input'
    ? 'Агент закончил и ждёт вашего сообщения — его можно отправить только в самой сессии.'
    : S.snap.hookInstalled ? 'Этот запрос открыт без связи со столом (появился до подключения хука) — ответьте в самой сессии. Новые запросы можно будет решать отсюда.' : 'Хук не установлен — ответить можно только в самой сессии.';
  const env = ENV_LABEL[a.entrypoint] || 'сессию', M = mach(a);
  if (M) return `<div class="card"><div class="kicker"><span class="k">${KIND_LABEL[att.kind] || 'Ждёт'}</span></div>${body}</div>${att.kind === 'input' ? sayBox(a, 'Ответ') : `<div class="note">Этот запрос открыт без связи со столом — ответьте в самой сессии на «${esc(M.name)}».</div>`}`;
  return `<div class="card"><div class="kicker"><span class="k">${KIND_LABEL[att.kind] || 'Ждёт'}</span></div>${body}<div class="note">${why}</div></div>
    <div class="btnrow"><button class="btn primary big" data-act="focus" data-key="${esc(a.key)}" data-primary>Перейти в ${env}</button></div>
    ${att.kind === 'input' ? sayBox(a, 'Ответ', 3) : ''}`;
}

// ---------- «Агент» ----------
function agentView() {
  const a = agentByKey(S.sheet.key);
  if (!a) return { html: head('Агент ушёл') + '<div class="sh-body"><div class="empty"><div class="big">👋</div><b>Сессия закрыта</b></div></div>', sig: 'gone' };
  const hosted = a.kind === 'hosted', M = mach(a);
  const env = ENV_LABEL[a.entrypoint] || a.entrypoint;
  const mm = M ? { models: M.models, efforts: M.efforts, modes: M.modes, extModes: M.extModes, modeHook: M.modeHookInstalled, hook: M.hookInstalled } : { models: S.snap.models, efforts: S.snap.efforts, modes: S.snap.modes, extModes: S.snap.extModes, modeHook: S.snap.modeHookInstalled, hook: S.snap.hookInstalled };
  const st = { busy: 'Работает', idle: 'Свободен', waiting: 'Ждёт вас', stopped: 'Уволен', error: 'Ошибка' }[a.status] || a.status;
  const h = head(esc(a.title || a.name || 'Агент'), `${esc(a.project)} · ${env}${hosted ? ' · ★ управляется из офиса' : ''}${M ? ` · ${M.online ? 'на связи' : 'нет связи'}` : ''}`, accent(a));
  const chips = [
    `<span class="chip st-${a.status}"><b>●</b> ${st}</span>`,
    a.model ? `<span class="chip">Модель <b>${esc(prettyModel(a.model))}</b></span>` : '',
    hosted && a.effort ? `<span class="chip">Effort <b>${esc(a.effort)}</b></span>` : '',
    a.mode ? `<span class="chip">Режим <b>${esc(MODE_LABEL[a.mode] || a.mode)}</b></span>` : '',
    hosted && a.cost ? `<span class="chip">$<b>${a.cost.toFixed(3)}</b></span>` : '',
    (a.subagents || []).length ? `<span class="chip">Сабагенты <b>${a.subagents.length}</b></span>` : '',
  ].join('');
  let banner = '';
  if (a.status === 'waiting') {
    const k = a.attention?.kind || 'input', amber = k === 'permission' || k === 'plan';
    banner = `<div class="banner${amber ? ' amber' : ''}" data-act="opendesk" data-key="${esc(a.key)}">${KIND_LABEL[k] || 'Ждёт'}: ${esc((a.attention?.text || '').slice(0, 80))}<button class="btn primary">Ответить</button></div>`;
  }
  let controls = '';
  const seg = (field, list, value, pend) => `<div class="seg wide${S.busy.has(a.key + field) ? ' busy' : ''}">${list.map((v) => `<button class="${v.value === value ? 'on' : ''}${v.value === pend ? ' pend' : ''}" data-act="set" data-field="${field}" data-value="${esc(v.value)}" data-key="${esc(a.key)}" title="${esc(v.title || '')}">${esc(v.label)}</button>`).join('')}</div>`;
  if (M && !M.online) banner += `<div class="banner">«${esc(M.name)}» не на связи — действия недоступны</div>`;
  if (!hosted && mm.modeHook) {
    const pend = a.pendingMode;
    controls = `<div class="ctl"><label>Режим</label>${seg('mode', (mm.extModes || []).map((m) => ({ value: m, label: MODE_LABEL[m] || m })), a.mode, pend)}</div>`
      + (pend ? `<div class="note pend">Включится «${esc(MODE_LABEL[pend] || pend)}» на ближайшем чтении или поиске агента${a.status === 'busy' ? '' : ' — когда он продолжит работу'}. <button class="btn ghost" data-act="set" data-field="mode" data-value="" data-key="${esc(a.key)}">Отменить</button></div>` : '');
  }
  if (hosted && a.controllable) {
    const models = mm.models?.length ? mm.models : FALLBACK_MODELS;
    const cur = models.find((m) => sameModel(m.value, a.model));
    const efforts = cur?.supportedEffortLevels?.length ? cur.supportedEffortLevels : mm.efforts || S.snap.efforts;
    controls = `
      <div class="ctl"><label>Модель</label>${seg('model', models.filter((m) => m.value !== 'default' && !/^claude-/.test(m.value)).slice(0, 5).map((m) => ({ value: m.value, label: m.displayName || m.value, title: m.description })), cur?.value)}</div>
      <div class="ctl"><label>Effort</label>${seg('effort', efforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] || e })), a.effort)}</div>
      <div class="ctl"><label>Режим</label>${seg('mode', (mm.modes || S.snap.modes).map((m) => ({ value: m, label: MODE_LABEL[m] || m })), a.mode)}</div>`;
  }
  let feed = '';
  if (hosted) {
    feed = (a.log || []).map((e) => {
      if (e.kind === 'user') return `<div class="ev user">${esc(e.text)}</div>`;
      if (e.kind === 'text') return `<div class="ev text md">${md(e.text)}</div>`;
      if (e.kind === 'tool') return `<div class="ev tool"><code>${esc(e.tool)}</code>${esc(e.text)}</div>`;
      return `<div class="ev ${e.kind}">${esc(e.text)}</div>`;
    }).join('');
  } else {
    const t = a.transcript || {};
    feed = `${t.lastPrompt ? `<div class="ev user">${esc(t.lastPrompt)}</div>` : ''}${t.lastAssistantText ? `<div class="ev text md">${md(t.lastAssistantText)}</div>` : ''}${t.pendingTool ? `<div class="ev tool"><code>${esc(t.pendingTool.name)}</code>${esc(t.pendingTool.summary)}</div>` : ''}`;
  }
  const subs = (a.subagents || []).length ? `<div class="subs"><div style="font-weight:600;color:var(--text)">Сабагенты</div>${a.subagents.map((s) => `<div><i></i>${esc(s.type)} — ${esc(s.description || '')}</div>`).join('')}</div>` : '';
  const note = hosted ? '' : `<div class="note">${M ? `Сессия на «${esc(M.name)}» (${env})` : `Внешняя сессия (${env})`}: модель и effort меняются только в ней самой. ${mm.modeHook ? 'Режим и сообщения — отсюда (режим включится, когда агент в следующий раз что-то прочитает или поищет).' : 'Режим отсюда — после <code>npm run hook:install</code>.'} На вопросы и разрешения можно отвечать со стола${S.snap.hookInstalled ? '' : ' после установки хука'}.</div>`;
  let foot;
  if (hosted && a.controllable) {
    foot = `<div class="sh-foot"><div class="composer"><textarea name="msg-${esc(a.key)}" rows="1" placeholder="Сообщение агенту… (⌘↩)"></textarea><button class="btn primary" data-act="send" data-key="${esc(a.key)}" data-primary>Отправить</button></div>
      <div class="row"><button class="btn" data-act="interrupt" data-key="${esc(a.key)}">Прервать</button><span class="grow"></span><button class="btn danger" data-act="stop" data-key="${esc(a.key)}">Уволить</button></div></div>`;
  } else if (hosted) {
    foot = '';
  } else {
    foot = `<div class="sh-foot">${canSay(a) ? `<div class="composer"><textarea name="say-${esc(a.key)}" rows="1" placeholder="Сообщение в сессию — отправится как ваш запрос (⌘↩)"></textarea><button class="btn primary" data-act="say" data-key="${esc(a.key)}" data-primary>Отправить</button></div>` : ''}${M ? '' : `<div class="row"><button class="btn" data-act="focus" data-key="${esc(a.key)}">Перейти в ${env}</button></div>`}</div>`;
  }
  const html = h + `<div class="sh-ctl"><div class="meta">${chips}</div>${banner}${controls}${note}</div><div class="sh-body"><div class="feed">${feed || '<div class="ev system">Пока тихо</div>'}</div>${subs}</div>${foot}`;
  const { updatedAt, statusUpdatedAt, ...stable } = a;
  return { html, sig: 'agent|' + JSON.stringify(stable) + '|' + JSON.stringify(S.snap.models) + '|' + [...S.busy].join(','), keepBottom: true };
}
const sameModel = (alias, model) => !!model && !!alias && (model === alias || String(model).toLowerCase().includes(String(alias).toLowerCase().replace(/\[.*\]$/, '')));
const prettyModel = (m) => String(m).replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/^./, (c) => c.toUpperCase());

// ---------- «Нанять» ----------
async function openHire(mid = '') {
  const M = mid ? (S.snap.machines || []).find((m) => m.id === mid) : null;
  let data = { projects: [], archive: [] };
  try { data = await fetch('/api/projects' + (mid ? '?m=' + encodeURIComponent(mid) : '')).then((r) => r.json()); if (data.error) throw new Error(data.error); } catch (e) { if (mid) toast(e.message || 'нет связи', true); }
  data.projects ||= []; data.archive ||= [];
  const online = (S.snap.machines || []).filter((m) => m.online);
  const where = online.length ? `<div class="ctl"><label>Где</label><div class="seg wide" data-name="where" data-value="${esc(mid)}"><button type="button" class="${mid ? '' : 'on'}" data-value="">Этот компьютер</button>${online.map((m) => `<button type="button" class="${m.id === mid ? 'on' : ''}" data-value="${esc(m.id)}">${esc(m.name)}</button>`).join('')}</div></div>` : '';
  const models = ((M ? M.models : S.snap.models)?.length ? (M ? M.models : S.snap.models) : FALLBACK_MODELS).filter((m) => m.value !== 'default' && !/^claude-/.test(m.value)).slice(0, 5);
  const segH = (name, list, value) => `<div class="seg wide" data-name="${name}" data-value="${esc(value)}">${list.map((v) => `<button type="button" class="${v.value === value ? 'on' : ''}" data-value="${esc(v.value)}">${esc(v.label)}</button>`).join('')}</div>`;
  const defModel = store.get('hire.model', models[0]?.value);
  const html = `
    <h2>Нанять агента</h2><p class="lead">Он сядет в зону проекта и сразу возьмётся за задачу. Вопросы, разрешения и план — через ваш стол; модель, effort и режим можно менять на лету.</p>
    ${where}
    <div class="field"><label>Проект</label><div class="projs">${data.projects.map((p, i) => `<label class="proj"><input type="radio" name="cwd" value="${esc(p.cwd)}"${i === 0 ? ' checked' : ''}><i style="background:${accentOf(p.project)}"></i><b>${esc(p.project)}</b><small>${esc(p.cwd.replace(/^\/Users\/[^/]+/, '~'))}</small></label>`).join('') || '<div class="note">Недавних проектов нет — укажите путь ниже.</div>'}</div>
      <input type="text" name="cwdCustom" placeholder="…или полный путь к папке, например /Users/me/project"></div>
    <div class="field"><label>Задача</label><textarea name="prompt" rows="4" placeholder="Что сделать? Можно оставить пустым — агент сядет и будет ждать указаний."></textarea></div>
    <div class="field"><label>Имя (необязательно)</label><input type="text" name="name" placeholder="Например: Ревьюер API"></div>
    <div class="ctl"><label>Модель</label>${segH('model', models.map((m) => ({ value: m.value, label: m.displayName || m.value })), defModel)}</div>
    <div class="ctl"><label>Effort</label>${segH('effort', S.snap.efforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] || e })), store.get('hire.effort', 'medium'))}</div>
    <div class="ctl"><label>Режим</label>${segH('mode', S.snap.modes.map((m) => ({ value: m, label: MODE_LABEL[m] || m })), store.get('hire.mode', 'default'))}</div>
    ${data.archive.length ? `<div class="field"><label>Вернуть на работу</label><div>${data.archive.map((e) => `<div class="arch"><span>${esc(e.title || e.name || 'Агент')} <small>· ${esc(e.cwd.split('/').pop())}</small></span><button class="btn" data-act="resume" data-id="${esc(e.id)}" data-machine="${esc(mid)}">Вернуть</button></div>`).join('')}</div></div>` : ''}
    <div class="btnrow" style="justify-content:flex-end"><button class="btn big" data-act="cancel">Отмена</button><button class="btn primary big" data-act="hire" data-primary>Нанять</button></div>`;
  $('#dialog').innerHTML = html;
  $('#modal').hidden = false;
  setTimeout(() => $('#dialog textarea[name=prompt]')?.focus(), 50);
}
// ---------- «Компьютеры» ----------
async function openMachines() {
  let st;
  try { st = await api('/api/remote/state', {}); } catch (e) { return toast(e.message, true); }
  const stLabel = { connecting: 'подключаюсь…', waiting: 'ждёт тот компьютер', offline: 'нет связи', error: 'ошибка', off: 'выключено' };
  const dot = (on) => `<i class="mdot${on ? ' on' : ''}"></i>`;
  const html = `
    <h2>Компьютеры</h2>
    <p class="lead">Агенты другого вашего компьютера — прямо в этом офисе: отвечайте, меняйте режим, нанимайте. Связь идёт через ваш ретранслятор и зашифрована от компьютера до компьютера — сам ретранслятор её не читает.</p>
    ${st.node22 ? '' : '<div class="banner">Нужен Node 22 или новее — обновите Node, чтобы связь заработала.</div>'}
    <div class="msect"><h3>Другие компьютеры — ими управляю отсюда</h3>
      ${st.machines.length ? st.machines.map((m) => `<div class="mrow">${dot(m.online)}<div class="tx"><b>${esc(m.name)}</b><small>${m.online ? `на связи · ${m.agents} ${plural(m.agents, 'агент', 'агента', 'агентов')}` : esc(m.error || stLabel[m.state] || m.state)}</small></div><button class="btn ghost" data-act="mrename" data-id="${esc(m.id)}" data-name="${esc(m.name)}">Переименовать</button><button class="btn ghost danger" data-act="mremove" data-id="${esc(m.id)}">Убрать</button></div>`).join('') : '<div class="note">Пока не подключено ни одного.</div>'}
      <div class="field"><label>Ретранслятор</label><input type="text" name="relayUrl" value="${esc(st.relay.url)}" placeholder="wss://…/aw  (можно одной строкой с ключом: wss://…/aw#ключ)"><input type="text" name="relayKey" placeholder="${st.relay.hasKey ? 'ключ сохранён — оставьте пустым, чтобы не менять' : 'ключ доступа к ретранслятору'}"><div class="row"><button class="btn" data-act="mrelay">Сохранить</button><span class="grow"></span><button class="btn primary" data-act="minvite"${st.relay.url ? '' : ' disabled'}>Добавить компьютер</button></div></div>
      <div id="inviteBox">${st.invites ? `<div class="note">Ждём тот компьютер… (${st.invites} ${plural(st.invites, 'приглашение', 'приглашения', 'приглашений')})</div>` : ''}</div>
    </div>
    <div class="msect"><h3>Этот компьютер — «${esc(st.me.name)}»</h3>
      <label class="mswitch"><input type="checkbox" data-act="mnode"${st.node.enabled ? ' checked' : ''}> Разрешить управлять им с другого компьютера</label>
      ${st.node.accept.map((a) => `<div class="mrow">${dot(a.online && st.node.enabled)}<div class="tx"><b>${esc(a.name)}</b><small>может управлять${a.online ? ' · на связи' : ''}${a.lastActionAt ? ` · последнее действие <span data-ago="${a.lastActionAt}"></span>` : ''}</small></div><button class="btn ghost danger" data-act="mrevoke" data-id="${esc(a.id)}">Отозвать</button></div>`).join('')}
      <div class="field"><label>Вставить приглашение с компьютера, который будет управлять этим (aw1.…)</label><textarea name="acceptInvite" rows="2" class="mono" placeholder="aw1.…"></textarea><div class="row"><button class="btn primary" data-act="maccept">Разрешить управлять</button></div></div>
    </div>
    <div class="btnrow" style="justify-content:flex-end"><button class="btn big" data-act="cancel">Закрыть</button></div>`;
  $('#dialog').innerHTML = html;
  $('#modal').hidden = false;
  refreshAges();
}
function closeModal() { $('#modal').hidden = true; $('#dialog').innerHTML = ''; }

// ---------- действия ----------
async function act(btn) {
  const d = btn.dataset, root = btn.closest('.sheet, .dialog') || document;
  const val = (name) => ($(`[name="${CSS.escape(name)}"]`, root)?.value || '').trim();
  const run = async (fn, ok) => { btn.disabled = true; try { await fn(); if (ok) toast(ok); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; } };
  switch (d.act) {
    case 'close': return closeSheet();
    case 'sel': S.sheet.sel = d.id; return renderSheet(true);
    case 'openagent': return openAgent(d.key);
    case 'opendesk': return openForAgent(d.key);
    case 'reveal': { const f = $(`[data-reveal="${d.target}"]`, root); if (f) { f.hidden = !f.hidden; $('textarea', f)?.focus(); } return; }
    case 'answer': {
      const it = S.snap.inbox.find((i) => i.id === d.id); if (!it) return toast('Запрос уже закрыт', true);
      const answers = {};
      for (const [qi, q] of (it.input.questions || []).entries()) {
        const checked = $$(`input[name="q${qi}"]:checked`, root).map((i) => i.value);
        const other = val(`q${qi}-other`);
        let vals = checked.map((v) => (v === '__other' ? other : v)).filter(Boolean);
        if (!checked.length && other) vals = [other];
        if (!vals.length) return toast(`Ответьте на «${q.question.slice(0, 50)}»`, true);
        answers[q.question] = q.multiSelect ? vals : vals[0];
      }
      return run(() => api(inboxUrl(d.id), { action: 'answer', answers }), 'Ответ отправлен');
    }
    case 'allow': return run(() => api(inboxUrl(d.id), { action: 'allow' }), 'Разрешено');
    case 'always': return run(() => api(inboxUrl(d.id), { action: 'allow', always: true }), 'Разрешено до конца сессии');
    case 'deny': return run(() => api(inboxUrl(d.id), { action: 'deny', message: d.msg || val('deny-' + d.id) }), 'Отклонено');
    case 'plan': return run(() => api(inboxUrl(d.id), { action: 'approvePlan', mode: d.mode }), 'План одобрен');
    case 'revise': return run(() => api(inboxUrl(d.id), { action: 'revisePlan', feedback: val('revise-' + d.id) }), 'Отправлено на доработку');
    case 'focus': return run(async () => { const r = await api(`/api/agents/${encodeURIComponent(d.key)}/focus`); if (r.result === 'notfound') throw new Error('Вкладка Terminal не найдена'); }, 'Переключаю…');
    case 'prefill': return run(() => api(`/api/agents/${encodeURIComponent(d.key)}/prefill`, { text: val('prefill-' + d.key) }), 'Открываю в VS Code');
    case 'say': {
      const text = val('say-' + d.key); if (!text) return;
      return run(async () => {
        const r = await api(`/api/agents/${encodeURIComponent(d.key)}/send`, { text });
        if (r.sent) { const ta = $(`[name="${CSS.escape('say-' + d.key)}"]`, root); if (ta) ta.value = ''; toast('Отправлено в сессию'); }
        else toast(r.hint || 'Не видно, чтобы сессия приняла запрос — проверьте её', true);
      });
    }
    case 'set': {
      const key = d.key, field = d.field;
      S.busy.add(key + field); renderSheet(true);
      try {
        const r = await api(`/api/agents/${encodeURIComponent(key)}/${field}`, { [field]: d.value });
        toast(r.cancelled ? 'Смена режима отменена' : r.applied === false ? 'Режим включится на ближайшем действии агента' : { model: 'Модель переключена', effort: 'Effort изменён', mode: 'Режим переключён' }[field]);
      }
      catch (e) { toast(e.message, true); }
      finally { S.busy.delete(key + field); renderSheet(true); }
      return;
    }
    case 'send': {
      const text = val('msg-' + d.key); if (!text) return;
      return run(async () => { await api(`/api/agents/${encodeURIComponent(d.key)}/message`, { text }); const ta = $(`[name="${CSS.escape('msg-' + d.key)}"]`, root); if (ta) ta.value = ''; }, 'Отправлено');
    }
    case 'ack': return run(() => api(`/api/reports/${encodeURIComponent(d.key)}/ack`), 'Отпустил отдыхать');
    case 'interrupt': return run(() => api(`/api/agents/${encodeURIComponent(d.key)}/interrupt`), 'Прервано');
    case 'stop': if (!confirm('Уволить агента? Сессия сохранится — его можно будет вернуть.')) return; return run(() => api(`/api/agents/${encodeURIComponent(d.key)}/stop`), 'Агент уволен');
    case 'cancel': return closeModal();
    case 'hire': {
      const dlg = $('#dialog');
      const cwd = val('cwdCustom') || ($('input[name=cwd]:checked', dlg)?.value || '');
      if (!cwd) return toast('Выберите проект', true);
      const seg = (n) => $(`.seg[data-name="${n}"]`, dlg)?.dataset.value;
      const body = { cwd, name: val('name'), prompt: val('prompt'), model: seg('model'), effort: seg('effort'), mode: seg('mode'), machine: seg('where') || undefined };
      store.set('hire.model', body.model); store.set('hire.effort', body.effort); store.set('hire.mode', body.mode);
      return run(async () => { const r = await api('/api/hire', body); closeModal(); setTimeout(() => openAgent(r.key), 400); }, 'Агент нанят — идёт к своему столу');
    }
    case 'resume': return run(async () => { const r = await api('/api/resume/' + encodeURIComponent(d.id), { machine: d.machine || undefined }); closeModal(); setTimeout(() => openAgent(r.key), 400); }, 'Агент вернулся');
    case 'maccept': {
      const inv = val('acceptInvite'); let who = 'другой компьютер';
      try { who = JSON.parse(atob(inv.replace(/^aw1\./, '').replace(/-/g, '+').replace(/_/g, '/'))).name || who; } catch { return toast('Это не приглашение AgentWatch (должно начинаться с aw1.)', true); }
      if (!confirm(`«${who}» сможет видеть агентов этого компьютера, отвечать им, менять режимы и нанимать агентов здесь. Разрешить?`)) return;
      return run(async () => { await api('/api/remote/accept', { invite: inv }); await openMachines(); }, `Теперь «${who}» может управлять этим компьютером`);
    }
    case 'mremove': if (!confirm('Убрать этот компьютер из офиса? Чтобы снова подключить, понадобится новое приглашение.')) return; return run(async () => { await api('/api/remote/remove', { id: d.id }); await openMachines(); }, 'Убран');
    case 'mrename': { const name = prompt('Новое название', d.name || ''); if (!name) return; return run(async () => { await api('/api/remote/rename', { id: d.id, name }); await openMachines(); }, 'Переименован'); }
    case 'mnode': return run(async () => { await api('/api/remote/node', { enabled: btn.checked }); await openMachines(); }, btn.checked ? 'Доступ извне включён' : 'Доступ извне выключен');
    case 'mrelay': return run(async () => { await api('/api/remote/relay', { url: val('relayUrl'), key: val('relayKey') || undefined }); await openMachines(); }, 'Ретранслятор сохранён');
    case 'mrevoke': if (!confirm('Отозвать доступ? Тот компьютер больше не сможет управлять этим.')) return; return run(async () => { await api('/api/remote/revoke', { id: d.id }); await openMachines(); }, 'Доступ отозван');
    case 'minvite': return run(async () => { const r = await api('/api/remote/invite', {}); const box = $('#inviteBox'); if (box) box.innerHTML = `<div class="field"><label>Приглашение — одноразовое, действует 15 минут</label><textarea readonly rows="3" class="mono" name="inviteOut">${esc(r.invite)}</textarea><div class="row"><button class="btn" data-act="copyinvite">Скопировать</button></div><div class="note">На том компьютере: офис AgentWatch → «Компьютеры» → вставить в «Вставить приглашение» → «Разрешить управлять». Он сразу появится в этом офисе.</div></div>`; });
    case 'copyinvite': { const t = $('[name=inviteOut]', root)?.value || ''; try { await navigator.clipboard.writeText(t); toast('Скопировано'); } catch { $('[name=inviteOut]', root)?.select(); toast('Выделено — нажмите ⌘C'); } return; }
  }
}
document.addEventListener('click', (e) => {
  const seg = e.target.closest('.dialog .seg[data-name] button');
  if (seg) { const p = seg.parentElement; p.dataset.value = seg.dataset.value; $$('button', p).forEach((b) => b.classList.toggle('on', b === seg)); if (p.dataset.name === 'where') openHire(seg.dataset.value); return; }
  const b = e.target.closest('[data-act]');
  if (b && (b.closest('#sheet') || b.closest('#dialog') || b.closest('#list'))) { e.preventDefault(); act(b); }
});
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('input', (e) => {
  if (e.target.dataset.other != null) { const r = $(`input[name="q${e.target.dataset.other}"][value="__other"]`, e.target.closest('.card')); if (r && e.target.value) r.checked = true; }
});

// ---------- клавиатура ----------
document.addEventListener('keydown', (e) => {
  const inField = e.target.matches('textarea, input[type=text]');
  if (inField) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { const ctx = e.target.closest('.composer, .field, .dialog, .sheet'); const b = $('[data-act="send"], [data-act="say"], [data-act="deny"], [data-act="revise"], [data-act="prefill"], [data-act="hire"]', ctx) || $('[data-primary]', ctx); if (b) { e.preventDefault(); act(b); } }
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') { if (!$('#modal').hidden) closeModal(); else closeSheet(); return; }
  if (!$('#modal').hidden) return;
  const k = e.key.toLowerCase();
  if (k === 'i' || k === 'ш') return openDesk();
  if (k === 'n' || k === 'т') return openHire();
  if (S.sheet?.type === 'desk') {
    const entries = deskEntries(), idx = entries.findIndex((x) => x.id === S.sheet.sel);
    if (k === 'j' || k === 'о' || e.key === 'ArrowDown') { S.sheet.sel = entries[Math.min(entries.length - 1, idx + 1)]?.id; renderSheet(true); return e.preventDefault(); }
    if (k === 'k' || k === 'л' || e.key === 'ArrowUp') { S.sheet.sel = entries[Math.max(0, idx - 1)]?.id; renderSheet(true); return e.preventDefault(); }
    if (/^[1-9]$/.test(e.key)) {
      const sheet = $('#sheet');
      const card = $$('.card[data-q]', sheet).find((c) => !$('input:checked', c)) || $$('.card[data-q]', sheet)[0];
      const opt = card && $$('input[type=radio], input[type=checkbox]', card)[Number(e.key) - 1];
      if (opt) { opt.checked = opt.type === 'checkbox' ? !opt.checked : true; }
      return;
    }
    if (e.key === 'Enter') { const b = $('#sheet [data-primary]'); if (b) { e.preventDefault(); act(b); } }
  }
});

// ---------- шапка, список, бейджи ----------
function renderBar() {
  const ag = S.snap.agents.filter((a) => a.status !== 'stopped');
  const de = deskEntries(), nD = de.filter((e) => e.report).length, nW = de.length - nD, nB = ag.filter((a) => a.status === 'busy').length, nI = ag.length - ag.filter((a) => a.status === 'waiting').length - nB - nD;
  $('#pWait b').textContent = nW; $('#pWait').classList.toggle('on', nW > 0);
  $('#pDone').hidden = !nD; $('#pDone b').textContent = nD;
  const ms = S.snap.machines || [], on = ms.filter((m) => m.online).length;
  $('#machBadge').hidden = !ms.length; $('#machBadge').textContent = `${on}/${ms.length}`; $('#machBadge').classList.toggle('off', on < ms.length);
  const rin = (S.snap.remoteIn || []).filter((r) => r.online);
  $('#pRemote').hidden = !rin.length; $('#pRemote span').textContent = rin.length ? `управляют с «${rin.map((r) => r.name).join('», «')}»` : '';
  $('#pBusy').textContent = nB; $('#pIdle').textContent = Math.max(0, nI);
  const projects = new Set(ag.map((a) => a.project)).size;
  $('#sub').textContent = `${ag.length} ${plural(ag.length, 'агент', 'агента', 'агентов')} · ${projects} ${plural(projects, 'проект', 'проекта', 'проектов')}`;
  $('#deskBadge').hidden = !(nW + nD); $('#deskBadge').textContent = nW + nD; $('#deskBadge').classList.toggle('green', !nW && nD > 0);
  document.title = (nW ? `(${nW}) ` : '') + 'Офис агентов';
  favicon(nW, nB);
  const hn = $('#hookNote');
  hn.hidden = S.snap.hookInstalled || store.get('hookNoteHidden', false);
  hn.innerHTML = 'Хук не установлен — внешним сессиям отвечать можно только в них самих. <code>npm run hook:install</code>';
}

function renderList() {
  const el = $('#list');
  el.hidden = S.view !== 'list';
  office?.setPaused?.(S.view === 'list');
  $$('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.view));
  $('#hint').hidden = S.view === 'list';
  if (S.view !== 'list') return;
  const by = new Map();
  for (const a of S.snap.agents.filter((x) => x.status !== 'stopped')) { if (!by.has(a.project)) by.set(a.project, []); by.get(a.project).push(a); }
  const rank = (a) => (a.status === 'waiting' ? 0 : a.status === 'busy' ? 1 : 2);
  el.innerHTML = [...by.entries()].sort((x, y) => Math.min(...x[1].map(rank)) - Math.min(...y[1].map(rank))).map(([p, list]) => `
    <div class="lhead"><i style="background:${accentOf(p)}"></i>${esc(p)} · ${list.length}</div>
    <div class="lgrid">${list.sort((x, y) => rank(x) - rank(y)).map((a) => `<div class="lcard ${a.status}" data-act="${a.status === 'waiting' ? 'opendesk' : 'openagent'}" data-key="${esc(a.key)}">
      <div class="t"><i></i><span>${esc(a.title || a.name)}</span><small>${ENV_LABEL[a.entrypoint] || ''}${a.kind === 'hosted' ? ' ★' : ''}</small></div>
      <small>${a.status === 'waiting' ? `${KIND_LABEL[a.attention?.kind] || 'Ждёт'} · <span data-ago="${a.statusUpdatedAt}"></span>` : a.transcript?.pendingTool ? esc(a.transcript.pendingTool.name + ': ' + a.transcript.pendingTool.summary) : ''}</small>
      <p>${esc(a.status === 'waiting' ? a.attention?.text || '' : a.transcript?.lastAssistantText || '')}</p></div>`).join('')}</div>`).join('') || '<div class="empty"><b>Живых сессий нет</b></div>';
  refreshAges();
}
$('#viewSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.view = b.dataset.v; store.set('view', S.view); renderList(); });
$('#bDesk').addEventListener('click', () => openDesk());
$('#pWait').addEventListener('click', () => openDesk());
$('#pDone').addEventListener('click', () => openDesk(deskEntries().find((e) => e.report)?.id));
$('#bHire').addEventListener('click', () => openHire());
$('#bMachines').addEventListener('click', () => openMachines());
$('#pRemote').addEventListener('click', () => openMachines());
$('#hookNote').addEventListener('click', () => { store.set('hookNoteHidden', true); $('#hookNote').hidden = true; });

function refreshAges() { for (const el of $$('[data-ago]')) el.textContent = ago(Number(el.dataset.ago)); }
setInterval(refreshAges, 15000);

function favicon(nW, nB) {
  const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
  x.fillStyle = nW ? '#ff3b30' : nB ? '#0a84ff' : '#8e8e93'; x.beginPath(); x.roundRect(4, 4, 56, 56, 16); x.fill();
  x.fillStyle = '#fff';
  if (nW) { x.font = 'bold 36px -apple-system, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(nW), 32, 35); }
  else for (const [px, py] of [[18, 18], [34, 18], [18, 34], [34, 34]]) { x.beginPath(); x.roundRect(px, py, 12, 12, 3); x.fill(); }
  $('#favicon').href = c.toDataURL();
}

// ---------- звук и уведомления ----------
function paintToggles() {
  $('#tSound').classList.toggle('on', S.sound);
  $('#tNotif').classList.toggle('on', S.notif && 'Notification' in window && Notification.permission === 'granted');
}
$('#tSound').addEventListener('click', () => { S.sound = !S.sound; store.set('sound', S.sound); paintToggles(); if (S.sound) chime(); });
$('#tNotif').addEventListener('click', async () => {
  if (!('Notification' in window)) return toast('Браузер не умеет уведомления', true);
  if (!S.notif) S.notif = (await Notification.requestPermission()) === 'granted'; else S.notif = false;
  store.set('notif', S.notif); paintToggles();
});
paintToggles();
let actx;
function chime() {
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = actx.currentTime;
    [[1046.5, 0], [1318.5, 0.11]].forEach(([f, dl]) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + dl); g.gain.linearRampToValueAtTime(0.14, t + dl + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + dl + 0.5);
      o.connect(g).connect(actx.destination); o.start(t + dl); o.stop(t + dl + 0.55);
    });
  } catch {}
}
function alerts() {
  const entries = deskEntries();
  const quiet = (e) => { const M = mach(e.agent); return M && Date.now() - (M.onlineSince || 0) < 5000; };
  const fresh = entries.filter((e) => !S.seen.has(e.id) && !quiet(e));
  if (!S.first && fresh.length) {
    if (S.sound) chime();
    if (S.notif && 'Notification' in window && Notification.permission === 'granted') {
      for (const e of fresh.slice(0, 3)) {
        const a = e.agent || {}, kind = e.report ? 'done' : e.item ? e.item.kind : a.attention?.kind;
        const n = new Notification(`${a.title || a.name || 'Агент'} — ${KIND_LABEL[kind] || 'ждёт вас'}`, { body: `${a.project || ''}: ${(e.report ? a.report.text : a.attention?.text || '').slice(0, 140)}`, tag: 'aw-' + e.id, silent: true });
        n.onclick = () => { window.focus(); openDesk(e.id); n.close(); };
      }
    }
  }
  S.seen = new Set(entries.map((e) => e.id));
  S.first = false;
}

// ---------- markdown (минимальный, безопасный) ----------
function md(src) {
  const blocks = [];
  let s = String(src || '').replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => { blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  const inline = (t) => t.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const out = []; let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of esc(s).split('\n')) {
    let m;
    if ((m = raw.match(/^\u0000(\d+)\u0000$/))) { closeList(); out.push(blocks[+m[1]]); }
    else if ((m = raw.match(/^\s*#{1,6}\s+(.*)/))) { closeList(); out.push(`<h3>${inline(m[1])}</h3>`); }
    else if ((m = raw.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = raw.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!raw.trim()) closeList();
    else { closeList(); out.push(`<p>${inline(raw)}</p>`); }
  }
  closeList();
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, n) => blocks[+n]);
}

// ---------- SSE ----------
function connect() {
  const es = new EventSource('/events');
  es.onmessage = (e) => {
    S.snap = JSON.parse(e.data);
    office?.update(S.snap);
    renderBar(); renderList(); renderSheet(); alerts();
  };
  es.onerror = () => { $('#sub').textContent = 'нет связи с сервером…'; es.close(); setTimeout(connect, 2000); };
}
connect();
window.__aw = { S, office, openDesk, openAgent, openHire, api };
