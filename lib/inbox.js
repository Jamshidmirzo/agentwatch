// «Мой стол»: единая очередь запросов от агентов — вопросы, разрешения, планы.
// Источники: canUseTool наёмных агентов (hosted) и хук PermissionRequest внешних сессий (hook).
// Решение со стола превращается в PermissionResult одинаково для обоих источников.
const { EventEmitter } = require('events');
const crypto = require('crypto');

const kindOf = (toolName) => toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'permission';

class Inbox extends EventEmitter {
  constructor() { super(); this.items = new Map(); }

  // settle(result|null): result — PermissionResult; null — «ответа не будет» (отпустить без решения)
  add({ agentKey, source, toolName, input, suggestions, settle, meta }) {
    const id = crypto.randomBytes(6).toString('hex');
    const item = { id, agentKey, source, kind: kindOf(toolName), toolName, input: input || {}, suggestions: suggestions || [], createdAt: Date.now(), settle, meta: meta || {} };
    this.items.set(id, item);
    this.emit('change');
    return item;
  }

  get(id) { return this.items.get(id); }
  forAgent(agentKey) { return [...this.items.values()].filter((i) => i.agentKey === agentKey); }

  resolve(id, decision) {
    const item = this.items.get(id);
    if (!item) throw new Error('запрос уже закрыт');
    const result = toPermissionResult(item, decision);
    this.items.delete(id);
    item.settle(result);
    this.emit('change');
    this.emit('resolved', item, decision);
    return result;
  }

  cancel(id) {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    try { item.settle(null); } catch {}
    this.emit('change');
  }

  cancelAgent(agentKey) { for (const i of this.forAgent(agentKey)) this.cancel(i.id); }

  list() {
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt).map((i) => ({
      id: i.id, agentKey: i.agentKey, source: i.source, kind: i.kind, toolName: i.toolName,
      input: trimInput(i.toolName, i.input), canAlways: i.suggestions.length > 0, createdAt: i.createdAt,
      cwd: i.meta.cwd || null,
    }));
  }
}

function trimInput(toolName, input) {
  if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') return input;
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    out[k] = typeof v === 'string' && v.length > 6000 ? v.slice(0, 6000) + '\n…' : v;
  }
  return out;
}

const sessionScoped = (updates) => (updates || []).map((u) => ({ ...u, destination: 'session' }));

// decision: { action: 'answer'|'allow'|'deny'|'approvePlan'|'revisePlan', answers, always, mode, message, feedback }
function toPermissionResult(item, d) {
  const input = item.input;
  switch (d.action) {
    case 'answer': {
      if (item.toolName !== 'AskUserQuestion') throw new Error('это не вопрос');
      const answers = {};
      for (const q of input.questions || []) {
        const a = d.answers && d.answers[q.question];
        if (a == null || a === '' || (Array.isArray(a) && !a.length)) throw new Error(`нет ответа на «${q.question}»`);
        answers[q.question] = Array.isArray(a) ? a.join(', ') : String(a);
      }
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }
    case 'allow': {
      const res = { behavior: 'allow', updatedInput: input };
      const ups = d.always ? sessionScoped(item.suggestions) : [];
      if (d.mode) ups.push({ type: 'setMode', mode: d.mode, destination: 'session' });
      if (ups.length) res.updatedPermissions = ups;
      return res;
    }
    case 'approvePlan':
      return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: d.mode || 'default', destination: 'session' }] };
    case 'revisePlan':
      return { behavior: 'deny', message: d.feedback ? `Пользователь просит доработать план: ${d.feedback}` : 'Пользователь просит доработать план.' };
    case 'deny':
      return { behavior: 'deny', message: d.message ? `Пользователь отклонил: ${d.message}` : 'Пользователь отклонил это действие.', interrupt: !!d.interrupt };
    default:
      throw new Error('неизвестное действие ' + d.action);
  }
}

module.exports = { Inbox, kindOf };
