// Мост для глобального http-хука PermissionRequest внешних сессий (VS Code / Terminal).
// Claude Code шлёт POST и параллельно показывает свой обычный диалог: кто ответил первым — тот и решил.
// Мы держим запрос (long-poll), пока пользователь не ответит со стола; если он ответил в самой
// сессии — отпускаем пустым ответом (= «нет решения»), и ничего не ломается.
const fs = require('fs');
const path = require('path');
const os = require('os');

// Смена режима внешней сессии: Claude Code меняет режим только ответом на запрос разрешения
// (updatedPermissions setMode). Поэтому кладём флаг ~/.agentwatch/mode/<session>, хук PreToolUse
// (bin/pretool.sh) на ближайшем безопасном инструменте просит разрешение, а мы тут же отвечаем allow + setMode.
const MODE_DIR = path.join(os.homedir(), '.agentwatch', 'mode');
const SEEN_DIR = path.join(os.homedir(), '.agentwatch', 'seen'); // текущий режим, который отмечает bin/pretool.sh
const EXT_MODES = ['default', 'acceptEdits', 'plan', 'auto'];
const SAFE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ToolSearch']);
const SID_RE = /^[0-9a-fA-F-]{8,64}$/;

const HOLD_MS = 29 * 60 * 1000; // в settings timeout хука 1800 с — отпускаем чуть раньше
const STALE_SCANS = 3;           // столько сканов подряд сессия «не ждёт» → считаем, что ответили там

class HookBridge {
  constructor({ inbox, hosted, onChange }) {
    this.inbox = inbox;
    this.hosted = hosted;
    this.onChange = onChange || (() => {});
    this.modes = new Map();   // sessionId -> { mode, at } — ждёт применения
    this.known = new Map();   // sessionId -> { mode, at } — режим, который мы видели в запросе или поставили сами
    this.seen = new Map();    // sessionId -> { mode, at } — из bin/pretool.sh
    try { fs.mkdirSync(SEEN_DIR, { recursive: true, mode: 0o700 }); } catch {}
    this.sessions = new Map();
    try { for (const f of fs.readdirSync(MODE_DIR)) if (SID_RE.test(f)) this.modes.set(f, { mode: fs.readFileSync(path.join(MODE_DIR, f), 'utf8').trim(), at: Date.now() }); } catch {}
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

    const sid = payload.session_id;
    if (payload.permission_mode) this.known.set(sid, { mode: payload.permission_mode, at: Date.now() });
    const pend = this.modes.get(sid);
    if (pend && SAFE_TOOLS.has(payload.tool_name)) { // наш собственный запрос ради смены режима
      this.applied(sid, pend.mode);
      return reply({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: payload.tool_input, updatedPermissions: [{ type: 'setMode', mode: pend.mode, destination: 'session' }] } } });
    }

    const dupKey = sid + '|' + payload.tool_name + '|' + JSON.stringify(payload.tool_input || {});
    const twin = [...this.pending.values()].find((e) => e.dupKey === dupKey && Date.now() - e.createdAt < 3000);
    if (twin) { twin.extra.push(reply); req.on('close', () => { twin.extra = twin.extra.filter((r) => r !== reply); }); return; }

    let entry;
    const item = this.inbox.add({
      agentKey: 'x:' + payload.session_id, source: 'hook',
      toolName: payload.tool_name, input: payload.tool_input, suggestions: payload.permission_suggestions,
      meta: { cwd: payload.cwd, sessionId: payload.session_id },
      settle: (result) => {
        clearTimeout(entry.timer);
        this.pending.delete(item.id);
        if (result && result.behavior === 'allow') { // разрешили — заодно применяем ожидающую смену режима
          const own = (result.updatedPermissions || []).find((u) => u.type === 'setMode');
          const p = this.modes.get(sid);
          if (own) this.applied(sid, own.mode);
          else if (p) { result = { ...result, updatedPermissions: [...(result.updatedPermissions || []), { type: 'setMode', mode: p.mode, destination: 'session' }] }; this.applied(sid, p.mode); }
        }
        const out = result ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: result } } : null;
        reply(out);
        for (const r of entry.extra) r(out);
      },
    });
    entry = { sessionId: payload.session_id, toolName: payload.tool_name, toolUseId: null, notWaiting: 0, createdAt: Date.now(), dupKey, extra: [] };
    entry.timer = setTimeout(() => this.inbox.cancel(item.id), HOLD_MS);
    this.pending.set(item.id, entry);
    req.on('close', () => { if (!res.writableEnded) this.inbox.cancel(item.id); }); // сессия закрылась / хук убит
  }

  // Вызывается после каждого скана реестра: снимаем запросы, на которые ответили в самой сессии.
  reconcile(sessions) {
    const bySession = new Map(sessions.map((s) => [s.sessionId, s]));
    this.sessions = bySession;
    for (const sid of bySession.keys()) {
      try {
        const f = path.join(SEEN_DIR, sid), st = fs.statSync(f), cur = this.seen.get(sid);
        if (!cur || cur.at !== st.mtimeMs) this.seen.set(sid, { mode: fs.readFileSync(f, 'utf8').trim(), at: st.mtimeMs });
      } catch {}
      const p = this.modes.get(sid), sm = this.seen.get(sid);
      if (p && sm && sm.mode === p.mode && sm.at > p.at) this.clearMode(sid); // уже включили — в самой сессии
    }
    for (const sid of [...this.seen.keys()]) if (!bySession.has(sid)) { this.seen.delete(sid); try { fs.unlinkSync(path.join(SEEN_DIR, sid)); } catch {} }
    for (const sid of [...this.modes.keys()]) if (!bySession.has(sid) && Date.now() - this.modes.get(sid).at > 60000) this.clearMode(sid);
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

  // ---------- режимы внешних сессий ----------
  modeOf(s) {
    const k = this.known.get(s.sessionId), v = this.seen.get(s.sessionId);
    const last = [k, v].filter(Boolean).sort((a, b) => b.at - a.at)[0];
    return last ? last.mode : s.transcript?.permissionMode ?? null;
  }
  pendingMode(sid) { return this.modes.get(sid)?.mode || null; }
  setMode(s, mode) {
    if (!EXT_MODES.includes(mode)) throw new Error('режим: ' + EXT_MODES.join(' | '));
    const sid = s.sessionId;
    if (!SID_RE.test(sid)) throw new Error('неверная сессия');
    if (this.modeOf(s) === mode) { this.clearMode(sid); return { applied: true }; }
    fs.mkdirSync(MODE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(MODE_DIR, sid), mode, { mode: 0o600 });
    this.modes.set(sid, { mode, at: Date.now() });
    this.onChange();
    return { applied: false };
  }
  clearMode(sid) {
    this.modes.delete(sid);
    try { fs.unlinkSync(path.join(MODE_DIR, sid)); } catch {}
    this.onChange();
  }
  applied(sid, mode) {
    this.known.set(sid, { mode, at: Date.now() });
    if (this.modes.has(sid)) this.clearMode(sid); else this.onChange();
  }

  releaseAll() { for (const id of [...this.pending.keys()]) this.inbox.cancel(id); }
}

module.exports = { HookBridge, EXT_MODES };
