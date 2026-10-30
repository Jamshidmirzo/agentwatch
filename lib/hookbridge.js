// Мост для глобального http-хука PermissionRequest внешних сессий (VS Code / Terminal).
// Claude Code шлёт POST и параллельно показывает свой обычный диалог: кто ответил первым — тот и решил.
// Мы держим запрос (long-poll), пока пользователь не ответит со стола; если он ответил в самой
// сессии — отпускаем пустым ответом (= «нет решения»), и ничего не ломается.
const HOLD_MS = 29 * 60 * 1000; // в settings timeout хука 1800 с — отпускаем чуть раньше
const STALE_SCANS = 3;           // столько сканов подряд сессия «не ждёт» → считаем, что ответили там

class HookBridge {
  constructor({ inbox, hosted }) {
    this.inbox = inbox;
    this.hosted = hosted;
    this.pending = new Map(); // inbox id -> { sessionId, toolName, toolUseId, notWaiting, res, timer }
  }

  // payload: { session_id, transcript_path, cwd, permission_mode, hook_event_name, tool_name, tool_input, permission_suggestions }
  handle(payload, req, res) {
    const reply = (obj) => {
      if (res.writableEnded) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(obj ? JSON.stringify(obj) : '');
    };
    if (!payload || payload.hook_event_name !== 'PermissionRequest' || !payload.session_id) return reply(null);
    // наёмные агенты офиса отвечают через canUseTool — хук для них не нужен
    if (this.hosted.hasSession(payload.session_id)) return reply(null);

    let entry;
    const item = this.inbox.add({
      agentKey: 'x:' + payload.session_id, source: 'hook',
      toolName: payload.tool_name, input: payload.tool_input, suggestions: payload.permission_suggestions,
      meta: { cwd: payload.cwd, sessionId: payload.session_id },
      settle: (result) => {
        clearTimeout(entry.timer);
        this.pending.delete(item.id);
        reply(result ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: result } } : null);
      },
    });
    entry = { sessionId: payload.session_id, toolName: payload.tool_name, toolUseId: null, notWaiting: 0, createdAt: Date.now() };
    entry.timer = setTimeout(() => this.inbox.cancel(item.id), HOLD_MS);
    this.pending.set(item.id, entry);
    req.on('close', () => { if (!res.writableEnded) this.inbox.cancel(item.id); }); // сессия закрылась / хук убит
  }

  // Вызывается после каждого скана реестра: снимаем запросы, на которые ответили в самой сессии.
  reconcile(sessions) {
    const bySession = new Map(sessions.map((s) => [s.sessionId, s]));
    const claimed = new Set([...this.pending.values()].map((e) => e.toolUseId).filter(Boolean));
    for (const [id, e] of this.pending) {
      const s = bySession.get(e.sessionId);
      if (!s) continue; // сессии нет в реестре (например, claude -p) — ждём ответа или закрытия соединения
      const pend = (s.transcript && s.transcript.pendingTools) || [];
      if (!e.toolUseId && Date.now() - e.createdAt > 1200) {
        const cand = [...pend].reverse().find((p) => p.name === e.toolName && !claimed.has(p.id));
        if (cand) { e.toolUseId = cand.id; claimed.add(cand.id); }
      }
      if (e.toolUseId && !pend.some((p) => p.id === e.toolUseId)) { this.inbox.cancel(id); continue; }
      e.notWaiting = s.status === 'waiting' ? 0 : e.notWaiting + 1;
      if (e.notWaiting >= STALE_SCANS && Date.now() - e.createdAt > 5000) this.inbox.cancel(id);
    }
  }

  releaseAll() { for (const id of [...this.pending.keys()]) this.inbox.cancel(id); }
}

module.exports = { HookBridge };
