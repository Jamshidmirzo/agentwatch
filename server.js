#!/usr/bin/env node
// AgentWatch — локальный дашборд за живыми сессиями Claude Code.
// Читает ~/.claude/sessions/*.json (реестр живых процессов) + хвост транскрипта
// ~/.claude/projects/<slug>/<sessionId>.jsonl, отдаёт SSE и умеет «прыгать» в окно.
// Зависимостей нет — только Node ≥ 18.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const HOME = os.homedir();
const SESS_DIR = path.join(HOME, '.claude', 'sessions');
const PROJ_DIR = path.join(HOME, '.claude', 'projects');
const PORT = Number(process.env.PORT || 4777);
const TAIL_BYTES = 384 * 1024;
const SCAN_MS = 2000;
const TTY_MAP_MS = 6000;

// ---------- helpers ----------
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const slugOf = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

function readTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (len < size) text = text.slice(text.indexOf('\n') + 1); // drop partial first line
    return text;
  } finally { fs.closeSync(fd); }
}

const transcriptIndex = new Map(); // sessionId -> file path (fallback search)
function findTranscript(cwd, sessionId) {
  const direct = path.join(PROJ_DIR, slugOf(cwd), sessionId + '.jsonl');
  if (fs.existsSync(direct)) return direct;
  if (transcriptIndex.has(sessionId)) return transcriptIndex.get(sessionId);
  try {
    for (const d of fs.readdirSync(PROJ_DIR)) {
      const p = path.join(PROJ_DIR, d, sessionId + '.jsonl');
      if (fs.existsSync(p)) { transcriptIndex.set(sessionId, p); return p; }
    }
  } catch {}
  return null;
}

function summarizeInput(name, input = {}) {
  if (name === 'Bash') return input.description || (input.command || '').slice(0, 160);
  if (name === 'AskUserQuestion') return (input.questions || []).map((q) => q.question).join(' · ');
  if (name === 'ExitPlanMode') return 'Ждёт одобрения плана';
  if (name === 'Agent') return input.description || (input.prompt || '').slice(0, 120);
  for (const k of ['file_path', 'pattern', 'query', 'url', 'description', 'prompt', 'command']) {
    if (typeof input[k] === 'string') return input[k].slice(0, 160);
  }
  const s = JSON.stringify(input);
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
}

// Parse tail of transcript into what the UI needs.
const parseCache = new Map(); // file -> { mtimeMs, size, parsed }
function parseTranscript(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const c = parseCache.get(file);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.parsed;

  const lines = readTail(file).split('\n');
  const entries = [];
  let aiTitle = null, lastPrompt = null, permissionMode = null;
  for (const line of lines) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'ai-title') aiTitle = d.aiTitle || aiTitle;
    else if (d.type === 'last-prompt') lastPrompt = d.lastPrompt || lastPrompt;
    else if (d.type === 'permission-mode') permissionMode = d.permissionMode || permissionMode;
    else if (d.type === 'assistant' || d.type === 'user') entries.push(d);
  }

  const results = new Set();
  let lastAssistantText = null, lastAssistantAt = null, lastUserText = null;
  const toolUses = []; // in order
  for (const d of entries) {
    const m = d.message || {};
    const content = m.content;
    if (d.type === 'user') {
      if (typeof content === 'string') lastUserText = content;
      else if (Array.isArray(content)) {
        for (const x of content) {
          if (x && x.type === 'tool_result') results.add(x.tool_use_id);
          else if (x && x.type === 'text') lastUserText = x.text;
        }
      }
    } else if (d.type === 'assistant' && Array.isArray(content)) {
      for (const x of content) {
        if (!x) continue;
        if (x.type === 'text' && x.text && x.text.trim()) { lastAssistantText = x.text.trim(); lastAssistantAt = d.timestamp; }
        else if (x.type === 'tool_use') toolUses.push({ id: x.id, name: x.name, input: x.input, at: d.timestamp });
      }
    }
  }
  const pending = toolUses.filter((t) => !results.has(t.id));
  const lastPending = pending[pending.length - 1] || null;

  let question = null;
  if (lastPending && lastPending.name === 'AskUserQuestion') {
    question = (lastPending.input.questions || []).map((q) => ({
      header: q.header, question: q.question, multi: !!q.multiSelect,
      options: (q.options || []).map((o) => o.label),
    }));
  }

  const parsed = {
    aiTitle, lastPrompt, permissionMode,
    lastAssistantText: lastAssistantText ? lastAssistantText.slice(0, 600) : null,
    lastAssistantAt,
    lastUserText: lastUserText ? lastUserText.slice(0, 300) : null,
    pendingTool: lastPending ? { name: lastPending.name, summary: summarizeInput(lastPending.name, lastPending.input), at: lastPending.at } : null,
    pendingCount: pending.length,
    question,
    transcriptMtime: st.mtimeMs,
  };
  parseCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, parsed });
  return parsed;
}

// Активные сабагенты: <slug>/<sessionId>/subagents/agent-*.meta.json без finished
// и с транскриптом, который писался недавно (страховка от убитых процессов).
const SUBAGENT_STALE_MS = 10 * 60 * 1000;
const metaCache = new Map(); // meta path -> { mtimeMs, meta }
function activeSubagents(tfile, sessionId) {
  const dir = path.join(path.dirname(tfile), sessionId, 'subagents');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  const now = Date.now();
  for (const n of names) {
    if (!n.endsWith('.meta.json')) continue;
    const mp = path.join(dir, n);
    let st; try { st = fs.statSync(mp); } catch { continue; }
    let c = metaCache.get(mp);
    if (!c || c.mtimeMs !== st.mtimeMs) {
      try { c = { mtimeMs: st.mtimeMs, meta: JSON.parse(fs.readFileSync(mp, 'utf8')) }; } catch { continue; }
      metaCache.set(mp, c);
    }
    if (c.meta.finished) continue;
    let jt; try { jt = fs.statSync(mp.replace(/\.meta\.json$/, '.jsonl')).mtimeMs; } catch { jt = st.mtimeMs; }
    if (now - jt > SUBAGENT_STALE_MS) continue;
    out.push({ id: n.replace(/^agent-|\.meta\.json$/g, ''), type: c.meta.agentType || 'agent', description: c.meta.description || '' });
  }
  return out;
}

// ---------- Terminal tty → window map (for CLI sessions) ----------
let ttyMap = { at: 0, byTty: {} };
function refreshTtyMap() {
  if (process.platform !== 'darwin') return;
  const script = `tell application "Terminal"
set out to ""
repeat with w in windows
  repeat with t in tabs of w
    set out to out & (id of w) & "\t" & (tty of t) & "\t" & (custom title of t) & linefeed
  end repeat
end repeat
return out
end tell`;
  execFile('osascript', ['-e', script], { timeout: 4000 }, (err, stdout) => {
    if (err) return; // Terminal не запущен — ок
    const byTty = {};
    for (const line of stdout.split('\n')) {
      const [wid, tty, title] = line.split('\t');
      if (tty) byTty[tty.trim()] = { windowId: Number(wid), title: (title || '').trim() };
    }
    ttyMap = { at: Date.now(), byTty };
  });
}

let pidTty = {}; // pid -> /dev/ttysNNN
function refreshPidTty(pids) {
  if (!pids.length) return;
  execFile('ps', ['-o', 'pid=,tty=', '-p', pids.join(',')], { timeout: 3000 }, (err, stdout) => {
    if (err) return;
    const m = {};
    for (const line of stdout.split('\n')) {
      const [pid, tty] = line.trim().split(/\s+/);
      if (pid && tty && tty !== '??') m[Number(pid)] = '/dev/' + tty;
    }
    pidTty = m;
  });
}

// ---------- snapshot ----------
let snapshot = { at: 0, sessions: [] };
function scan() {
  let files = [];
  try { files = fs.readdirSync(SESS_DIR).filter((f) => f.endsWith('.json')); } catch {}
  const sessions = [];
  const cliPids = [];
  for (const f of files) {
    let r; try { r = JSON.parse(fs.readFileSync(path.join(SESS_DIR, f), 'utf8')); } catch { continue; }
    if (!r.pid || !alive(r.pid)) continue;
    const tfile = findTranscript(r.cwd || HOME, r.sessionId);
    const t = tfile ? parseTranscript(tfile) : null;
    if (r.entrypoint === 'cli') cliPids.push(r.pid);
    const tty = pidTty[r.pid] || null;
    const term = tty && ttyMap.byTty[tty] ? ttyMap.byTty[tty] : null;

    // Что показывать как «внимание»
    let attention = null; // { kind: question|permission|plan|input, text }
    if (r.status === 'waiting') {
      if (t && t.question) attention = { kind: 'question', text: t.question.map((q) => q.question).join(' · ') };
      else if (t && t.pendingTool && t.pendingTool.name === 'ExitPlanMode') attention = { kind: 'plan', text: 'Одобрить план' };
      else if (t && t.pendingTool) attention = { kind: 'permission', text: `${t.pendingTool.name}: ${t.pendingTool.summary}` };
      else attention = { kind: 'input', text: r.waitingFor || 'Нужен ответ' };
    }

    sessions.push({
      pid: r.pid, sessionId: r.sessionId, cwd: r.cwd, project: path.basename(r.cwd || '') || r.cwd,
      name: r.name, nameSource: r.nameSource, entrypoint: r.entrypoint, version: r.version,
      status: r.status || 'idle', waitingFor: r.waitingFor || null,
      startedAt: r.startedAt, updatedAt: r.updatedAt, statusUpdatedAt: r.statusUpdatedAt || r.updatedAt,
      title: (t && t.aiTitle) || (term && term.title.replace(/^[◐◑◒◓●○◉\s]+/, '')) || r.name,
      tty, terminal: term,
      transcript: t,
      subagents: tfile ? activeSubagents(tfile, r.sessionId) : [],
      attention,
    });
  }
  refreshPidTty(cliPids);
  if (Date.now() - ttyMap.at > TTY_MAP_MS && cliPids.length) refreshTtyMap();
  snapshot = { at: Date.now(), sessions };
  broadcast();
}

// ---------- focus ----------
function focus(pid, cb) {
  const s = snapshot.sessions.find((x) => x.pid === pid);
  if (!s) return cb(new Error('session not found'));
  if (s.entrypoint === 'claude-vscode') {
    const url = `vscode://anthropic.claude-code/open?session=${encodeURIComponent(s.sessionId)}`;
    return execFile('open', [url], (err) => cb(err, { via: 'vscode', url }));
  }
  if (s.entrypoint === 'cli' && s.tty) {
    const script = `tell application "Terminal"
repeat with w in windows
  repeat with t in tabs of w
    if tty of t is "${s.tty}" then
      set selected tab of w to t
      set frontmost of w to true
      activate
      return "ok"
    end if
  end repeat
end repeat
return "notfound"
end tell`;
    return execFile('osascript', ['-e', script], { timeout: 4000 }, (err, out) => cb(err, { via: 'terminal', result: (out || '').trim() }));
  }
  cb(new Error(`unsupported entrypoint ${s.entrypoint}`));
}

// ---------- http / sse ----------
const clients = new Set();
function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
  for (const res of clients) res.write(payload);
}

const INDEX = path.join(__dirname, 'index.html');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(INDEX).pipe(res);
  }
  if (url.pathname === '/factory.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(__dirname, 'factory.js')).pipe(res);
  }
  if (url.pathname === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(snapshot));
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const m = url.pathname.match(/^\/api\/focus\/(\d+)$/);
  if (m && req.method === 'POST') {
    return focus(Number(m[1]), (err, info) => {
      res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(err ? { ok: false, error: err.message } : { ok: true, ...info }));
    });
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`AgentWatch → http://localhost:${PORT}`);
  scan();
  refreshTtyMap();
  setInterval(scan, SCAN_MS);
});
