// «Наёмные» агенты: сессии Claude Code, которые офис запускает сам через Agent SDK.
// Над ними полный пульт: ответы на вопросы/разрешения/план (canUseTool → inbox),
// смена модели, effort и режима на лету, сообщения, interrupt, stop.
// Под капотом — установленный ~/.local/bin/claude в headless-режиме под логином пользователя.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.agentwatch');
const STATE_FILE = path.join(STATE_DIR, 'hosted.json');
const MODELS_FILE = path.join(STATE_DIR, 'models.json');
const CLAUDE_BIN = [path.join(HOME, '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'].find((p) => fs.existsSync(p));
const LOG_MAX = 80;
const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

let sdkPromise = null;
const sdk = () => (sdkPromise ??= import('@anthropic-ai/claude-agent-sdk'));

// Очередь пользовательских сообщений → AsyncIterable для streaming input.
function inputQueue() {
  const buf = [];
  let wake = null, closed = false;
  return {
    push(msg) { if (closed) return; buf.push(msg); wake?.(); wake = null; },
    close() { closed = true; wake?.(); wake = null; },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (buf.length) { yield buf.shift(); continue; }
        if (closed) return;
        await new Promise((r) => { wake = r; });
      }
    },
  };
}

const userMsg = (text) => ({
  type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, origin: { kind: 'human' },
});

function summarizeTool(name, input = {}) {
  if (name === 'Bash') return input.description || String(input.command || '').slice(0, 160);
  if (name === 'AskUserQuestion') return (input.questions || []).map((q) => q.question).join(' · ');
  if (name === 'ExitPlanMode') return 'План готов';
  if (name === 'Agent' || name === 'Task') return input.description || '';
  for (const k of ['file_path', 'pattern', 'query', 'url', 'description', 'command']) if (typeof input[k] === 'string') return input[k].slice(0, 160);
  return '';
}

class HostedAgent extends EventEmitter {
  constructor(mgr, opts) {
    super();
    this.mgr = mgr;
    this.id = opts.id || crypto.randomBytes(5).toString('hex');
    this.key = 'h:' + this.id;
    this.cwd = opts.cwd;
    this.project = path.basename(opts.cwd);
    this.name = opts.name || '';
    this.title = opts.title || opts.name || '';
    this.model = opts.model || null;
    this.effort = opts.effort || null;
    this.mode = opts.mode || 'default';
    this.sessionId = opts.sessionId || null;
    this.createdAt = opts.createdAt || Date.now();
    this.startedAt = Date.now();
    this.updatedAt = Date.now();
    this.statusUpdatedAt = Date.now();
    this.status = 'starting'; // starting|busy|idle|waiting|stopped|error
    this.log = [];
    this.cost = opts.cost || 0;
    this.lastText = null;
    this.lastPrompt = null;
    this.currentTool = null;
    this.tasks = new Map(); // task_id -> { description, type }
    this.error = null;
    this.query = null;
    this.input = null;
    this.pendingResults = 0; // открытые запросы canUseTool
  }

  push(kind, text, extra = {}) {
    this.log.push({ t: Date.now(), kind, text: String(text ?? '').slice(0, 4000), ...extra });
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
    this.updatedAt = Date.now();
  }

  setStatus(s) {
    if (this.pendingResults > 0 && s !== 'stopped' && s !== 'error') s = 'waiting';
    if (s === this.status) return;
    this.status = s;
    this.statusUpdatedAt = Date.now();
    this.mgr.changed();
  }

  async start({ prompt, resume }) {
    const { query } = await sdk();
    this.input = inputQueue();
    const options = {
      cwd: this.cwd,
      permissionMode: this.mode,
      allowDangerouslySkipPermissions: true,
      settingSources: ['user', 'project', 'local'],
      canUseTool: (toolName, input, ctx) => this.canUseTool(toolName, input, ctx),
      stderr: (s) => { if (/error/i.test(s)) this.push('error', s.trim().slice(0, 500)); },
    };
    if (CLAUDE_BIN) options.pathToClaudeCodeExecutable = CLAUDE_BIN;
    if (this.model) options.model = this.model;
    if (this.effort) options.effort = this.effort;
    if (resume) options.resume = resume;
    this.query = query({ prompt: this.input, options });
    if (prompt) this.send(prompt); else this.setStatus('idle');
    this.consume().catch((e) => {
      this.error = String(e && e.message || e);
      this.push('error', this.error);
      this.setStatus('error');
    });
    this.query.supportedModels?.().then((m) => this.mgr.setModels(m)).catch(() => {});
  }

  async consume() {
    for await (const m of this.query) {
      this.updatedAt = Date.now();
      if (m.session_id && !this.sessionId) { this.sessionId = m.session_id; this.mgr.persist(); }
      if (m.type === 'system') {
        if (m.subtype === 'init') {
          this.sessionId = m.session_id; this.model = m.model || this.model;
          if (m.permissionMode) this.mode = m.permissionMode;
          this.mgr.persist();
        } else if (m.subtype === 'session_state_changed') {
          this.setStatus(m.state === 'idle' ? 'idle' : m.state === 'requires_action' ? 'waiting' : 'busy');
        } else if (m.subtype === 'task_started') {
          this.tasks.set(m.task_id, { id: m.task_id, type: m.subagent_type || 'task', description: m.description || '' });
        } else if (m.subtype === 'task_notification') {
          this.tasks.delete(m.task_id);
        }
      } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
        if (m.message?.model) this.model = m.message.model;
        for (const b of m.message?.content || []) {
          if (b.type === 'text' && b.text?.trim()) { this.lastText = b.text.trim(); this.push('text', this.lastText); }
          else if (b.type === 'tool_use') {
            this.currentTool = { name: b.name, summary: summarizeTool(b.name, b.input) };
            this.push('tool', this.currentTool.summary, { tool: b.name });
          }
        }
        if (this.status !== 'waiting') this.setStatus('busy');
      } else if (m.type === 'result') {
        if (typeof m.total_cost_usd === 'number') this.cost = m.total_cost_usd;
        this.currentTool = null;
        if (m.subtype !== 'success') this.push('error', m.errors?.join('; ') || m.subtype);
        this.push('result', `Готово · $${(this.cost || 0).toFixed(3)}`);
        this.mgr.persist();
        this.setStatus('idle');
      }
      this.mgr.changed();
    }
    this.setStatus('stopped');
  }

  canUseTool(toolName, input, ctx) {
    return new Promise((resolve) => {
      this.pendingResults++;
      this.setStatus('waiting');
      const item = this.mgr.inbox.add({
        agentKey: this.key, source: 'hosted', toolName, input, suggestions: ctx?.suggestions || [],
        settle: (result) => {
          this.pendingResults = Math.max(0, this.pendingResults - 1);
          this.setStatus('busy');
          resolve(result || { behavior: 'deny', message: 'Запрос снят (агент остановлен).', interrupt: true });
        },
      });
      ctx?.signal?.addEventListener?.('abort', () => this.mgr.inbox.cancel(item.id), { once: true });
    });
  }

  send(text) {
    if (!this.input) throw new Error('агент не запущен');
    this.lastPrompt = text;
    this.push('user', text);
    this.input.push(userMsg(text));
    this.setStatus('busy');
  }

  async setModel(model) { await this.query.setModel(model); this.model = model; this.push('system', `Модель → ${model}`); this.mgr.persist(); this.mgr.changed(); }
  async setEffort(effort) {
    if (!EFFORTS.includes(effort)) throw new Error('effort: ' + EFFORTS.join('|'));
    await this.query.applyFlagSettings({ effortLevel: effort }); this.effort = effort; this.push('system', `Effort → ${effort}`); this.mgr.persist(); this.mgr.changed();
  }
  async setMode(mode) {
    if (!MODES.includes(mode)) throw new Error('mode: ' + MODES.join('|'));
    await this.query.setPermissionMode(mode); this.mode = mode; this.push('system', `Режим → ${mode}`); this.mgr.persist(); this.mgr.changed();
  }
  async interrupt() { await this.query.interrupt(); this.push('system', 'Остановлено пользователем'); }
  stop() {
    this.mgr.inbox.cancelAgent(this.key);
    try { this.input?.close(); } catch {}
    try { this.query?.close(); } catch {}
    this.status = 'stopped';
    this.statusUpdatedAt = Date.now();
    this.mgr.persist();
    this.mgr.changed();
  }

  toJSON() {
    const subs = [...this.tasks.values()];
    let attention = null;
    const items = this.mgr.inbox.forAgent(this.key);
    if (items.length) {
      const i = items[0];
      attention = { kind: i.kind, text: i.kind === 'question' ? (i.input.questions || []).map((q) => q.question).join(' · ') : i.kind === 'plan' ? 'Одобрить план' : `${i.toolName}: ${summarizeTool(i.toolName, i.input)}`, inboxId: i.id };
    }
    return {
      key: this.key, kind: 'hosted', id: this.id, sessionId: this.sessionId, cwd: this.cwd, project: this.project,
      name: this.name, title: this.title || this.name || this.lastPrompt?.slice(0, 60) || 'Новый агент',
      entrypoint: 'office', status: this.status === 'starting' ? 'busy' : this.status,
      startedAt: this.startedAt, updatedAt: this.updatedAt, statusUpdatedAt: this.statusUpdatedAt,
      model: this.model, effort: this.effort, mode: this.mode, cost: this.cost, error: this.error,
      subagents: subs, attention, controllable: this.status !== 'stopped',
      transcript: {
        lastAssistantText: this.lastText, lastPrompt: this.lastPrompt,
        pendingTool: this.currentTool ? { name: this.currentTool.name, summary: this.currentTool.summary } : null,
      },
      log: this.log.slice(-40),
    };
  }
}

class HostedManager extends EventEmitter {
  constructor(inbox) {
    super();
    this.inbox = inbox;
    this.agents = new Map(); // key -> HostedAgent
    this.models = loadJSON(MODELS_FILE, null);
    this.archive = loadJSON(STATE_FILE, []); // уволенные/прошлые — можно вернуть через resume
  }

  changed() { this.emit('change'); }

  setModels(list) {
    if (!Array.isArray(list) || !list.length) return;
    this.models = list.map((m) => ({ value: m.value, displayName: m.displayName, description: m.description, supportsEffort: m.supportsEffort, supportedEffortLevels: m.supportedEffortLevels }));
    saveJSON(MODELS_FILE, this.models);
    this.changed();
  }

  async hire({ cwd, name, prompt, model, effort, mode }) {
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('папка проекта не найдена: ' + cwd);
    if (mode && !MODES.includes(mode)) throw new Error('mode: ' + MODES.join('|'));
    if (effort && !EFFORTS.includes(effort)) throw new Error('effort: ' + EFFORTS.join('|'));
    const a = new HostedAgent(this, { cwd, name, title: name || (prompt || '').slice(0, 60), model, effort, mode: mode || 'default' });
    this.agents.set(a.key, a);
    a.push('system', `Нанят в ${a.project}`);
    await a.start({ prompt: prompt && prompt.trim() ? prompt.trim() : null });
    this.persist();
    this.changed();
    return a;
  }

  async resume(entryId, prompt) {
    const e = this.archive.find((x) => x.id === entryId);
    if (!e || !e.sessionId) throw new Error('нечего возвращать');
    const live = this.agents.get('h:' + e.id);
    if (live && live.status !== 'stopped') return live;
    const a = new HostedAgent(this, { ...e });
    this.agents.set(a.key, a);
    a.push('system', 'Вернулся на работу');
    await a.start({ prompt: prompt || null, resume: e.sessionId });
    this.persist();
    this.changed();
    return a;
  }

  get(key) { return this.agents.get(key); }
  hasSession(sessionId) { return !!sessionId && [...this.agents.values()].some((a) => a.sessionId === sessionId && a.status !== 'stopped'); }

  list() {
    // уволенные исчезают из офиса через минуту
    const now = Date.now();
    for (const [k, a] of this.agents) if (a.status === 'stopped' && now - a.statusUpdatedAt > 60000) this.agents.delete(k);
    return [...this.agents.values()].map((a) => a.toJSON());
  }

  archiveList() {
    const live = new Set([...this.agents.values()].filter((a) => a.status !== 'stopped').map((a) => a.id));
    return this.archive.filter((e) => e.sessionId && !live.has(e.id)).slice(-20).reverse();
  }

  persist() {
    const byId = new Map(this.archive.map((e) => [e.id, e]));
    for (const a of this.agents.values()) {
      byId.set(a.id, { id: a.id, cwd: a.cwd, name: a.name, title: a.title || a.lastPrompt?.slice(0, 60) || '', model: a.model, effort: a.effort, mode: a.mode, sessionId: a.sessionId, createdAt: a.createdAt, cost: a.cost, lastAt: a.updatedAt });
    }
    this.archive = [...byId.values()].sort((x, y) => (x.lastAt || 0) - (y.lastAt || 0)).slice(-60);
    saveJSON(STATE_FILE, this.archive);
  }

  stopAll() { for (const a of this.agents.values()) if (a.status !== 'stopped') a.stop(); }
}

function loadJSON(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }
function saveJSON(f, v) {
  try { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, JSON.stringify(v, null, 2), { mode: 0o600 }); } catch {}
}

module.exports = { HostedManager, MODES, EFFORTS, CLAUDE_BIN };
