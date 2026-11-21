// Tether: a self-hosted phone client for Claude Code running on your own computer.
// Runs the real Claude Code CLI (your own login) through the Agent SDK.
// Listens on localhost only by default; phones reach it through Tailscale. Phone auth = secret key.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { execFileSync, execFile, spawn } from 'node:child_process';
import readline from 'node:readline';
import { query, listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.CM_DATA || path.join(ROOT, 'data');
const CHATS = path.join(DATA, 'chats');
const PUBLIC = path.join(ROOT, 'public');
fs.mkdirSync(CHATS, { recursive: true, mode: 0o700 });
fs.chmodSync(DATA, 0o700);

const PORT = Number(process.env.PORT || 8787);
// Only localhost: phones reach it through Tailscale HTTPS (tailscale serve :8443 -> here).
const HOSTS = (process.env.HOSTS || '127.0.0.1').split(',').map((h) => h.trim()).filter(Boolean);
// Safety: this app can run commands on this computer, so it must never listen on every network.
for (const h of HOSTS) {
  if (['0.0.0.0', '::', '[::]', '*'].includes(h)) {
    console.error(`Refusing to start: HOSTS contains "${h}", which would open this app to every network.\nUse 127.0.0.1 (with "tailscale serve") or your Tailscale IP.`);
    process.exit(1);
  }
}
const IDLE_CLOSE_MS = 20 * 60 * 1000;

// ---------- settings: config.json (copy config.example.json) ----------
const CONFIG_FILE = process.env.CM_CONFIG || path.join(ROOT, 'config.json');
const expand = (p) => path.resolve(String(p).replace(/^~(?=$|[\\/])/, os.homedir()));
let CONFIG = {};
try { CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
catch (e) {
  if (e.code !== 'ENOENT') { console.error(`Can't read ${CONFIG_FILE}: ${e.message}`); process.exit(1); }
}
const CLAUDE_BIN = process.env.CLAUDE_BIN || (CONFIG.claudeBin ? expand(CONFIG.claudeBin) : path.join(os.homedir(), '.local/bin/claude'));
// projects: { "name": "~/folder" }  or  { "name": { "path": "~/folder", "tmux": "session-name" } }
// "tmux" is optional: it lets the phone join the Claude already open in that tmux session.
const PROJECTS = {}, PC_TMUX = {};
for (const [name, v] of Object.entries(CONFIG.projects || {})) {
  const o = typeof v === 'string' ? { path: v } : (v || {});
  if (!/^[\w.-]{1,40}$/.test(name) || !o.path) { console.error(`config.json: bad project "${name}" (letters, numbers, . _ - only, and it needs a path)`); process.exit(1); }
  PROJECTS[name] = expand(o.path);
  if (o.tmux) PC_TMUX[name] = String(o.tmux);
}
// Test mode: only a practice tmux session, never the real ones.
if (process.env.CM_TEST_DIR) { for (const k of Object.keys(PC_TMUX)) delete PC_TMUX[k]; PROJECTS.test = process.env.CM_TEST_DIR; PC_TMUX.test = 'cmtest'; }
if (!Object.keys(PROJECTS).length) {
  console.error(`No projects yet. Copy config.example.json to config.json and list the folders Claude may work in.`);
  process.exit(1);
}
for (const [name, dir] of Object.entries(PROJECTS)) if (!fs.existsSync(dir)) console.error(`Warning: project "${name}" points to a folder that doesn't exist: ${dir}`);
const DEFAULT_PROJECT = Object.keys(PROJECTS)[0];
const has = (o, k) => typeof k === 'string' && Object.hasOwn(o, k);
// folders: { "Downloads": "~/Downloads" }  Extra places the phone may browse, download from and upload to
// in the Files screen. Claude does not work in them; they are only for moving files.
const FOLDERS = {};
for (const [name, v] of Object.entries(CONFIG.folders || {})) {
  if (!/^[\w.-]{1,40}$/.test(name) || typeof v !== 'string' || !v) { console.error(`config.json: bad folder "${name}" (letters, numbers, . _ - only, and it needs a path)`); process.exit(1); }
  if (PROJECTS[name]) { console.error(`config.json: "${name}" is used for both a project and a folder. Give them different names.`); process.exit(1); }
  FOLDERS[name] = expand(v);
  if (!fs.existsSync(FOLDERS[name])) console.error(`Warning: folder "${name}" doesn't exist: ${FOLDERS[name]}`);
}
// Everything the Files screen may reach: project folders plus the extra folders.
const ROOTS = { ...PROJECTS, ...FOLDERS };

// ---------- token ----------
const TOKEN_FILE = path.join(DATA, 'token');
if (!fs.existsSync(TOKEN_FILE)) {
  fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString('base64url'), { mode: 0o600 });
}
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
const tokenOk = (t) => {
  const a = Buffer.from(String(t || '')), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Always use the subscription login, never an API key that might be in the env.
const childEnv = { ...process.env };
delete childEnv.ANTHROPIC_API_KEY;
delete childEnv.ANTHROPIC_AUTH_TOKEN;
childEnv.CLAUDE_CODE_ENTRYPOINT = 'tether';

const log = (...a) => console.log(new Date().toISOString(), ...a);
// At most 20 of these lines a minute, so a flood of bad attempts can't fill the disk.
let limitedN = 0; setInterval(() => { if (limitedN > 20) log('(' + (limitedN - 20) + ' more like that hidden)'); limitedN = 0; }, 60000).unref();
const logLimited = (...a) => { if (++limitedN <= 20) log(...a); };
const rid = () => crypto.randomBytes(6).toString('base64url');

// ---------- chats ----------
// A chat = our id + project + Claude session id + an event log.
// Events have a seq; the phone asks for "everything after seq N" when it reconnects.
const chats = new Map();

function metaPath(id) { return path.join(CHATS, id + '.json'); }
function logPath(id) { return path.join(CHATS, id + '.jsonl'); }

function loadChats() {
  for (const f of fs.readdirSync(CHATS)) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(CHATS, f), 'utf8'));
      chats.set(meta.id, { meta, events: null, seq: meta.seq || 0, runner: null, cids: new Set() });
    } catch (e) { log('bad chat file', f, e.message); }
  }
}

function events(chat) {
  if (chat.events) return chat.events;
  chat.events = [];
  try {
    const lines = fs.readFileSync(logPath(chat.meta.id), 'utf8').split('\n');
    for (const l of lines) if (l) {
      const ev = JSON.parse(l);
      chat.events.push(ev);
      if (ev.t === 'user' && ev.cid) chat.cids.add(ev.cid);
    }
  } catch {}
  // Numbers must keep going up. The saved counter can lag behind the log (it was only saved now and then),
  // and a restart then reused numbers the phone had already seen, so the phone skipped new messages.
  let max = 0, bad = false;
  for (const ev of chat.events) { if (!(ev.seq > max)) bad = true; else max = ev.seq; }
  if (bad) {
    // Older logs already have repeated numbers: renumber them and make phones reload this chat once.
    let n = 0;
    for (const ev of chat.events) ev.seq = ++n;
    fs.writeFileSync(logPath(chat.meta.id), chat.events.map((ev) => JSON.stringify(ev)).join('\n') + (n ? '\n' : ''), { mode: 0o600 });
    chat.seq = n; chat.meta.resetBelow = n + 1; saveMeta(chat);
    log('renumbered chat log', chat.meta.id, n);
  } else chat.seq = Math.max(chat.seq, max);
  // An approval that was waiting when the server stopped can't be answered any more.
  const open = new Map();
  for (const ev of chat.events) {
    if (ev.t === 'perm') open.set(ev.id, ev);
    if (ev.t === 'permdone') open.delete(ev.id);
  }
  for (const id of open.keys()) {
    const ev = { seq: ++chat.seq, t: 'permdone', id, ok: false, why: 'server restarted' };
    chat.events.push(ev);
    fs.appendFileSync(logPath(chat.meta.id), JSON.stringify(ev) + '\n', { mode: 0o600 });
  }
  return chat.events;
}

function saveMeta(chat) {
  chat.meta.seq = chat.seq;
  fs.writeFileSync(metaPath(chat.meta.id), JSON.stringify(chat.meta), { mode: 0o600 });
}

function newChat(project, extra = {}) {
  const id = rid();
  const chat = {
    meta: { id, project, sessionId: null, title: 'New chat', updated: Date.now(), created: Date.now(), ...extra },
    events: [], seq: 0, runner: null, cids: new Set(),
  };
  chats.set(id, chat);
  saveMeta(chat);
  return chat;
}

// persist=false for streaming text pieces (the final text replaces them).
function emit(chat, ev, persist = true) {
  events(chat);
  ev.seq = ++chat.seq;
  chat.events.push(ev);
  if (persist) {
    const { _live, ...disk } = ev;
    fs.appendFileSync(logPath(chat.meta.id), JSON.stringify(disk) + '\n', { mode: 0o600 });
  }
  chat.meta.updated = Date.now();
  broadcast(chat, ev);
}

function publicEvent(ev) {
  if (!ev.full) return ev;
  const { full, ...rest } = ev;
  return rest;
}

// Events after `since`, without streaming pieces of text blocks that are already final.
function eventsSince(chat, since) {
  const evs = events(chat);
  const out = [];
  const final = new Set();
  for (const ev of evs) if (ev.seq > since && ev.t === 'tf') final.add(ev.b);
  for (const ev of evs) {
    if (ev.seq <= since) continue;
    if (ev.t === 'ts' && final.has(ev.b)) continue;
    out.push(publicEvent(ev));
  }
  return out;
}

function chatSummary(chat) {
  const r = chat.runner;
  if (chat.meta.pc) { const st = chat.pcState?.status; return { ...chat.meta, seq: chat.seq, busy: st === 'busy' || st === 'waiting', waiting: st === 'waiting', live: !!st && st !== 'off', mode: chat.pcState?.mode || null, effort: chat.pcState?.effort || null, model: chat.pcState?.model || null }; }
  return { ...chat.meta, seq: chat.seq, busy: !!(r && r.busy), waiting: !!(r && r.perms.size) };
}

// ---------- Claude runner (one live Claude Code process per active chat) ----------
function summarizeInput(name, input = {}) {
  const s = (v) => String(v ?? '');
  const short = (p) => s(p).replace(os.homedir(), '~');
  switch (name) {
    case 'Bash': return s(input.command);
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return short(input.file_path || input.notebook_path);
    case 'Glob': return s(input.pattern);
    case 'Grep': return s(input.pattern) + (input.path ? '  in ' + short(input.path) : '');
    case 'WebFetch': return s(input.url);
    case 'WebSearch': return s(input.query);
    case 'Agent': case 'Task': return s(input.description || input.prompt).slice(0, 120);
    case 'TodoWrite': return (input.todos || []).map((t) => (t.status === 'completed' ? '✓ ' : '• ') + t.content).join('\n');
    case 'Skill': return s(input.skill);
    case 'AskUserQuestion': return (input.questions || []).map((q) => q.question).join(' · ');
    default: {
      const j = JSON.stringify(input);
      return j.length > 160 ? j.slice(0, 160) + '…' : j;
    }
  }
}

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
function toolEvent(c) {
  const ev = { t: 'tool', id: c.id, name: c.name, sum: summarizeInput(c.name, c.input) };
  const fp = c.input && (c.input.file_path || c.input.notebook_path);
  if (FILE_TOOLS.has(c.name) && fp) ev.file = String(fp);
  if (c.name === 'Edit' && c.input) ev.diff = { old: String(c.input.old_string || '').slice(0, 4000), new: String(c.input.new_string || '').slice(0, 4000) };
  return ev;
}

function permDetail(name, input = {}) {
  if (name === 'Edit') return { old: String(input.old_string || '').slice(0, 1500), new: String(input.new_string || '').slice(0, 1500) };
  if (name === 'Write') return { new: String(input.content || '').slice(0, 1500) };
  if (name === 'Bash' && input.description) return { note: String(input.description) };
  return null;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : '')).join('\n');
  return content == null ? '' : JSON.stringify(content);
}

class Runner {
  constructor(chat) {
    this.chat = chat;
    this.queue = [];
    this.wake = null;
    this.busy = false;
    this.perms = new Map();       // id -> { resolve, input, name }
    this.openText = [];           // FIFO of text block keys being streamed
    this.blockKeys = new Map();   // stream index -> key, for the current message
    this.pending = new Map();     // key -> buffered delta text (flushed every 60 ms)
    this.flushTimer = null;
    this.idleTimer = null;
    this.closed = false;
    this.start();
  }

  async *input() {
    while (!this.closed) {
      if (this.queue.length) { yield this.queue.shift(); continue; }
      await new Promise((r) => (this.wake = r));
      this.wake = null;
    }
  }

  send(text) {
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: this.chat.meta.sessionId || '' });
    this.setBusy(true);
    clearTimeout(this.idleTimer);
    this.wake && this.wake();
  }

  setBusy(b) {
    if (this.busy === b) return;
    this.busy = b;
    broadcastMeta(this.chat);
  }

  start() {
    const chat = this.chat;
    const cwd = PROJECTS[chat.meta.project] || PROJECTS[DEFAULT_PROJECT];
    this.q = query({
      prompt: this.input(),
      options: {
        cwd,
        resume: chat.meta.sessionId || undefined,
        pathToClaudeCodeExecutable: fs.existsSync(CLAUDE_BIN) ? CLAUDE_BIN : undefined,
        includePartialMessages: true,
        permissionMode: 'default',
        systemPrompt: {
          type: 'preset', preset: 'claude_code',
          append: 'The user is on their phone (small screen, maybe weak signal). Keep replies short and scannable; lead with the answer.',
        },
        env: childEnv,
        canUseTool: (name, input, opts) => this.ask(name, input, opts),
        stderr: (d) => { if (/error/i.test(d)) log('[claude]', d.trim().slice(0, 300)); },
      },
    });
    this.loop().catch((e) => {
      log('runner error', chat.meta.id, e.message);
      emit(chat, { t: 'err', msg: String(e.message || e).slice(0, 400) });
    }).finally(() => this.finish());
  }

  ask(name, input, { signal, suggestions }) {
    const chat = this.chat;
    const id = rid();
    const ev = { t: 'perm', id, tool: name, sum: summarizeInput(name, input) };
    if (name === 'AskUserQuestion') ev.questions = (input.questions || []).map((q) => ({ q: q.question, multi: !!q.multiSelect, opts: (q.options || []).map((o) => ({ l: o.label, d: o.description })) }));
    else {
      const d = permDetail(name, input);
      if (d) ev.detail = d;
      ev.always = !!(suggestions && suggestions.length);
    }
    emit(chat, ev);
    broadcastMeta(chat);
    return new Promise((resolve) => {
      const done = (res, ok, why) => {
        if (!this.perms.has(id)) return;
        this.perms.delete(id);
        emit(chat, { t: 'permdone', id, ok, why });
        broadcastMeta(chat);
        resolve(res);
      };
      this.perms.set(id, { name, input, suggestions, done });
      signal && signal.addEventListener('abort', () => done({ behavior: 'deny', message: 'Cancelled' }, false, 'cancelled'));
    });
  }

  answer(id, choice) {
    const p = this.perms.get(id);
    if (!p) return;
    if (p.name === 'AskUserQuestion') {
      if (choice.answers) {
        p.done({ behavior: 'allow', updatedInput: { ...p.input, answers: choice.answers } }, true, Object.values(choice.answers).join(', '));
      } else p.done({ behavior: 'deny', message: 'The user dismissed the question.' }, false, 'dismissed');
      return;
    }
    if (choice.allow) {
      const res = { behavior: 'allow', updatedInput: p.input };
      if (choice.always && p.suggestions) res.updatedPermissions = p.suggestions;
      p.done(res, true, choice.always ? 'always' : 'once');
    } else {
      p.done({ behavior: 'deny', message: choice.note ? 'The user denied this: ' + choice.note : 'The user denied this action.' }, false, 'denied');
    }
  }

  keyFor(index) {
    let k = this.blockKeys.get(index);
    if (!k) { k = rid(); this.blockKeys.set(index, k); }
    return k;
  }

  queueDelta(key, text) {
    this.pending.set(key, (this.pending.get(key) || '') + text);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 60);
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const [b, d] of this.pending) emit(this.chat, { t: 'ts', b, d }, false);
    this.pending.clear();
  }

  async loop() {
    const chat = this.chat;
    for await (const m of this.q) {
      if (m.type === 'system' && m.subtype === 'init') {
        log('session', m.session_id, 'model', m.model, 'auth', m.apiKeySource, 'cwd', m.cwd);
        if (m.session_id && chat.meta.sessionId !== m.session_id) { chat.meta.sessionId = m.session_id; saveMeta(chat); }
        if (m.model && chat.meta.model !== m.model) { chat.meta.model = m.model; saveMeta(chat); }
        continue;
      }
      if (m.type === 'stream_event') {
        if (m.parent_tool_use_id) continue;
        const e = m.event;
        if (e.type === 'message_start') this.blockKeys = new Map();
        else if (e.type === 'content_block_start' && e.content_block?.type === 'text') this.openText.push(this.keyFor(e.index));
        else if (e.type === 'content_block_start' && e.content_block?.type === 'thinking') emit(chat, { t: 'think' }, false);
        else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') this.queueDelta(this.keyFor(e.index), e.delta.text);
        continue;
      }
      if (m.type === 'assistant') {
        if (m.parent_tool_use_id) continue;
        this.flush();
        for (const c of m.message?.content || []) {
          if (c.type === 'text' && c.text) emit(chat, { t: 'tf', b: this.openText.shift() || rid(), text: c.text });
          else if (c.type === 'tool_use') emit(chat, toolEvent(c));
        }
        if (m.error) emit(chat, { t: 'err', msg: String(m.error) });
        continue;
      }
      if (m.type === 'user') {
        if (m.parent_tool_use_id) continue;
        const content = m.message?.content;
        if (!Array.isArray(content)) continue;
        for (const c of content) {
          if (c.type !== 'tool_result') continue;
          const full = toolResultText(c.content);
          emit(chat, { t: 'tres', id: c.tool_use_id, ok: !c.is_error, prev: full.slice(0, 280), n: full.length, full: full.length > 280 ? full.slice(0, 200000) : undefined });
        }
        continue;
      }
      if (m.type === 'result') {
        this.flush();
        this.openText = [];
        const ev = { t: 'done', ms: m.duration_ms };
        if (m.subtype !== 'success') ev.err = m.subtype === 'error_max_turns' ? 'Stopped: too many steps' : (m.errors?.join?.('; ') || m.subtype);
        if (m.is_error && m.result) ev.err = String(m.result).slice(0, 400);
        if (this.stopping) { delete ev.err; ev.stopped = true; this.stopping = false; }
        emit(chat, ev);
        if (!this.queue.length) this.setBusy(false);
        saveMeta(chat);
        this.armIdle();
        continue;
      }
      if (m.type === 'rate_limit_event' && m.rate_limit_info?.status === 'rejected') {
        emit(chat, { t: 'err', msg: 'Usage limit reached. Resets ' + (m.rate_limit_info.resetsAt ? new Date(m.rate_limit_info.resetsAt * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'later') });
      }
    }
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.busy && !this.perms.size) this.close(); }, IDLE_CLOSE_MS);
  }

  async stop() {
    if (!this.busy) return;
    this.stopping = true;
    for (const p of [...this.perms.values()]) p.done({ behavior: 'deny', message: 'Stopped by the user', interrupt: true }, false, 'stopped');
    try { await this.q.interrupt(); } catch (e) { log('interrupt failed', e.message); }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.wake && this.wake();
    try { this.q.close(); } catch {}
  }

  finish() {
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.flush();
    for (const p of [...this.perms.values()]) p.done({ behavior: 'deny', message: 'Session ended' }, false, 'ended');
    if (this.chat.runner === this) this.chat.runner = null;
    if (this.busy) { this.busy = false; emit(this.chat, { t: 'done', err: 'Claude stopped unexpectedly. Send again to continue.' }); }
    broadcastMeta(this.chat);
  }
}

function sendToChat(chat, text, cid) {
  events(chat);
  if (cid && chat.cids.has(cid)) return; // already got it (phone resent after a drop)
  if (cid) chat.cids.add(cid);
  if (chat.meta.title === 'New chat') { chat.meta.title = text.replace(/\s+/g, ' ').slice(0, 60); saveMeta(chat); }
  emit(chat, { t: 'user', text, cid });
  if (!chat.runner || chat.runner.closed) chat.runner = new Runner(chat);
  chat.runner.send(text);
}

// ---------- "On PC" chats: one Claude, two screens ----------
// The phone drives the real Claude running in tmux on the PC (the session named by "tmux" for that
// project in config.json). It reads that Claude's chat file live and types into its tmux pane,
// so the PC screen and the phone always show the same conversation. Projects without "tmux" skip this.

const SESS_DIR = path.join(os.homedir(), '.claude/sessions');

function tmux(...args) { return execFileSync('tmux', args, { encoding: 'utf8', timeout: 5000 }); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

// The terminal Claude writes ~/.claude/sessions/<pid>.json: chat id, tmux spot, busy/idle/waiting.
function pcProcess(project) {
  const name = PC_TMUX[project];
  let best = null;
  for (const f of fs.readdirSync(SESS_DIR)) {
    if (!f.endsWith('.json')) continue;
    let d; try { d = JSON.parse(fs.readFileSync(path.join(SESS_DIR, f), 'utf8')); } catch { continue; }
    if (d.entrypoint !== 'cli' || !d.tmux || !d.tmux.startsWith(name + ':') || !alive(d.pid)) continue;
    if (!best || (d.updatedAt || 0) > (best.updatedAt || 0)) best = d;
  }
  return best;
}

function sessionPath(project, sessionId) {
  return path.join(os.homedir(), '.claude/projects', PROJECTS[project].replace(/[^a-zA-Z0-9]/g, '-'), sessionId + '.jsonl');
}

// Compare messages ignoring whitespace and the wrapper Claude Code puts around long pastes.
const sameMsg = (t) => String(t).replace(/<\/?pasted_content[^>]*>/g, '').replace(/\s+/g, ' ').trim();
function emitMessage(chat, type, content, opts = {}) {
  // opts.seen: messages the phone already has (same chat picked up again after a restart): don't add them twice.
  const seen = opts.seen;
  const put = (ev) => {
    if (seen) {
      const key = ev.t === 'tool' || ev.t === 'tres' ? ev.t + ':' + ev.id : ev.t + ':' + sameMsg(ev.text || '');
      if (seen.has(key)) return;
    }
    if (opts.count) opts.count.n++;
    emit(chat, ev);
  };
  if (type === 'user') {
    const texts = typeof content === 'string' ? [content] : (content || []).filter((c) => c.type === 'text').map((c) => c.text);
    for (const t of texts) {
      if (!t || !t.trim() || t.startsWith('[Request interrupted')) continue;
      if (t.trim().startsWith('<') && !t.trim().startsWith('<pasted_content')) continue;
      // Our own phone message coming back from the PC's chat file: already shown.
      const pend = chat.pendingTexts || [];
      const i = pend.findIndex((p) => sameMsg(p) === sameMsg(t));
      if (i >= 0) { pend.splice(i, 1); continue; }
      put({ t: 'user', text: t.replace(/<\/?pasted_content[^>]*>/g, '').trim(), src: opts.live ? 'pc' : undefined });
    }
    if (Array.isArray(content)) for (const c of content) {
      if (c.type === 'tool_result') { const full = toolResultText(c.content); put({ t: 'tres', id: c.tool_use_id, ok: !c.is_error, prev: full.slice(0, 280), n: full.length, full: full.length > 280 ? full.slice(0, 200000) : undefined }); }
    }
  } else if (type === 'assistant') {
    for (const c of content || []) {
      if (c.type === 'text' && c.text) put({ t: 'tf', b: rid(), text: c.text });
      if (c.type === 'tool_use') put(toolEvent(c));
    }
  }
}

function pcChat(project) {
  const id = 'pc-' + project;
  let chat = chats.get(id);
  if (!chat) {
    chat = { meta: { id, project, pc: true, sessionId: null, title: project + ' on PC', updated: Date.now(), created: Date.now() }, events: [], seq: 0, runner: null, cids: new Set() };
    chats.set(id, chat);
    saveMeta(chat);
  }
  chat.pendingTexts = chat.pendingTexts || [];
  chat.pcState = chat.pcState || { status: 'off', permId: null };
  return chat;
}

async function loadPcHistory(chat, sessionId) {
  let msgs = [];
  try { msgs = await getSessionMessages(sessionId, { dir: PROJECTS[chat.meta.project] }); } catch (e) { log('pc history', e.message); }
  const tail = msgs.slice(-80);
  // Claude restarted with --continue brings back the same chat: only add what the phone doesn't have yet.
  const seen = new Set();
  for (const ev of events(chat)) {
    if (ev.t === 'tool' || ev.t === 'tres') seen.add(ev.t + ':' + ev.id);
    else if (ev.t === 'user' || ev.t === 'tf') seen.add(ev.t + ':' + sameMsg(ev.text || ''));
  }
  const fresh = !chat.meta.sessionId;
  const overlap = tail.some((m) => (m.message?.content || []).some?.((c) => c.type === 'tool_use' && seen.has('tool:' + c.id)));
  if (!overlap) emit(chat, { t: 'note', text: fresh ? 'Live with Claude on your PC. Both screens show the same chat.' : 'The PC started a different chat. Showing it now.' });
  for (const m of tail) if (!m.parent_tool_use_id) emitMessage(chat, m.type, m.message?.content, overlap ? { seen } : {});
}

// Read the approval question from the PC screen.
function readPrompt(target) {
  let lines;
  try { lines = tmux('capture-pane', '-p', '-J', '-t', target).split('\n'); } catch { return null; }
  const optRe = /^\s*(?:❯\s*)?(\d)\.\s+(.+?)\s*$/;
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (optRe.test(lines[i])) { last = i; break; }
  if (last < 0) return null;
  let first = last;
  while (first > 0 && (optRe.test(lines[first - 1]) || /^\s{3,}\S/.test(lines[first - 1]))) first--;
  const opts = [];
  for (let i = first; i <= last; i++) {
    const m = lines[i].match(optRe);
    if (m) opts.push({ n: m[1], l: m[2].replace(/\s+·.*$/, '') });
    else if (opts.length) opts[opts.length - 1].l += ' ' + lines[i].trim();
  }
  let q = first - 1;
  while (q > 0 && !lines[q].trim()) q--;
  const question = lines[q] ? lines[q].trim() : 'Allow?';
  let top = q - 1;
  while (top > 0 && !/^[─━]{10,}/.test(lines[top].trim())) top--;
  const body = lines.slice(top + 1, q).map((l) => l.trim()).filter((l) => l && !/^[╌─]{10,}$/.test(l) && !/^Tip:|^below$/.test(l));
  const title = body.shift() || 'Claude asks';
  return { title, question, body: body.join('\n').slice(0, 2000), opts };
}

// Claude's pick-an-option questions (AskUserQuestion) on the PC screen. One question shows at a time:
//   [tabs line with ☐/☒]  question  "❯ 1. Label" (+ indented description)  ... "N. Type something."  ─────  "N+1. Chat about this"
//   footer "Enter to select · ... to navigate". Multi-select options look like "1. [ ] Label".
// After the last question a review screen shows "Review your answers" with "1. Submit answers / 2. Cancel".
function readAsk(target) {
  let lines;
  try { lines = tmux('capture-pane', '-p', '-J', '-t', target).split('\n').map((l) => l.replace(/\s+$/, '')); } catch { return null; }
  let foot = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/Enter to select · .*to navigate/.test(lines[i])) { foot = i; break; }
  const reviewAt = lines.findIndex((l) => /^\s*Review your answers\s*$/.test(l));
  if (reviewAt >= 0) {
    const body = [];
    let i = reviewAt + 1;
    for (; i < lines.length && !/Ready to submit/.test(lines[i]); i++) { const t = lines[i].trim().replace(/^●\s*/, ''); if (t) body.push(t.startsWith('→') ? '   ' + t : t); }
    const opts = [];
    for (; i < lines.length; i++) { const m = lines[i].match(/^\s*(?:❯\s*)?(\d)\.\s+(.+?)\s*$/); if (m) opts.push({ n: m[1], l: m[2] }); }
    if (!opts.length) return null;
    return { review: true, key: 'review|' + body.join('|'), title: 'Submit your answers?', body: body.join('\n'), opts };
  }
  if (foot < 0) return null;
  let sep = foot - 1;
  while (sep > 0 && !/^\s*[─━]{10,}/.test(lines[sep])) sep--;
  let head = sep - 1;
  while (head > 0 && !/[☐☒]/.test(lines[head])) head--;
  if (head <= 0) return null;
  const tabs = (lines[head].match(/[☐☒✔]\s*[^☐☒✔←→]+/g) || []).map((t) => ({ done: t[0] !== '☐', l: t.slice(1).trim() })).filter((t) => t.l && t.l !== 'Submit');
  let qi = head + 1;
  while (qi < sep && !lines[qi].trim()) qi++;
  const q = (lines[qi] || '').trim();
  const opts = [];
  const optRe = /^\s*(?:❯\s*)?(\d+)\.\s+(?:\[([ ✔])\]\s+)?(.*?)\s*$/;
  for (let i = qi + 1; i < sep; i++) {
    const m = lines[i].match(optRe);
    if (m) { opts.push({ n: m[1], l: m[3], checked: m[2] === '✔', box: m[2] != null }); continue; }
    const t = lines[i].trim();
    if (t && t !== 'Submit' && opts.length) opts[opts.length - 1].d = (opts[opts.length - 1].d ? opts[opts.length - 1].d + ' ' : '') + t;
  }
  if (!q || !opts.length) return null;
  const other = opts.find((o) => /^Type something\.?$/.test(o.l));
  const real = opts.filter((o) => o !== other);
  const multi = opts.some((o) => o.box);
  return { key: q + '|' + real.map((o) => o.l).join('|'), q, multi, tabs, opts: real.map(({ n, l, d, checked }) => ({ n, l, d, checked })), other: other ? other.n : null };
}

// Type the phone's answer for the question now on screen.
function pcAsk(chat, msg) {
  const st = chat.pcState;
  if (!st.permId || msg.id !== st.permId) return;
  const proc = pcProcess(chat.meta.project);
  if (!proc || proc.status !== 'waiting') return;
  const pane = paneOf(proc, chat.meta.project);
  const a = readAsk(pane);
  if (!a || a.review || a.key !== st.askKey) return;
  const keys = (...k) => tmux('send-keys', '-t', pane, ...k);
  const lit = (t) => tmux('send-keys', '-t', pane, '-l', t);
  if (!msg.answers) { st.lastAnswer = 'no'; st.askAnswer = 'Skipped'; return keys('Escape'); }
  const raw = String(Object.values(msg.answers)[0] || '');
  const want = a.multi ? raw.split(/,\s*/).filter(Boolean) : [raw];
  const known = want.filter((w) => a.opts.some((o) => o.l === w));
  const typed = want.filter((w) => !a.opts.some((o) => o.l === w)).join(', ').replace(/[\r\n]+/g, ' ').slice(0, 500);
  st.askAnswer = want.join(', ');
  if (a.multi) {
    for (const o of a.opts) if (known.includes(o.l) !== !!o.checked) keys(o.n);
    if (typed && a.other) { keys(a.other); lit(typed); }
    keys('Tab');
  } else if (known.length) keys(a.opts.find((o) => o.l === known[0]).n);
  else if (typed && a.other) { keys(a.other); lit(typed); setTimeout(() => { try { keys('Enter'); } catch {} }, 150); }
}

function pcTick(project) {
  const chat = pcChat(project);
  const proc = pcProcess(project);
  const st = chat.pcState;
  const status = proc ? proc.status : 'off';

  if (proc && proc.sessionId !== chat.meta.sessionId) {
    const sid = proc.sessionId;
    st.loading = true;
    loadPcHistory(chat, sid).finally(() => {
      chat.meta.sessionId = sid;
      try { chat.meta.pcOffset = fs.statSync(sessionPath(project, sid)).size; } catch { chat.meta.pcOffset = 0; }
      saveMeta(chat); st.loading = false; broadcastMeta(chat);
    });
    return;
  }
  if (st.loading) return;

  // New lines in the PC's chat file -> phone.
  if (proc) {
    const f = sessionPath(project, proc.sessionId);
    let size = 0; try { size = fs.statSync(f).size; } catch {}
    if (size > (chat.meta.pcOffset || 0)) {
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(Math.min(size - chat.meta.pcOffset, 8 * 1024 * 1024));
      fs.readSync(fd, buf, 0, buf.length, chat.meta.pcOffset);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      const end = text.lastIndexOf('\n');
      if (end >= 0) {
        chat.meta.pcOffset += Buffer.byteLength(text.slice(0, end + 1));
        for (const line of text.slice(0, end).split('\n')) {
          let d; try { d = JSON.parse(line); } catch { continue; }
          if (d.entrypoint === 'tether' || d.isSidechain || d.isMeta) continue;
          // Claude's automatic summary when a chat gets too long: show a small note, not a fake user message.
          if (d.isCompactSummary || d.isVisibleInTranscriptOnly) { emit(chat, { t: 'note', text: 'Chat got long, so Claude summarized the older part. Nothing was lost.' }); continue; }
          if (d.type === 'user' || d.type === 'assistant') {
            emitMessage(chat, d.type, d.message?.content, { live: true });
            const txt = d.type === 'assistant' && (d.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
            if (txt) st.lastFinal = norm(txt);
            if (st.live) { st.live = ''; sendLive(chat, { clear: true }); }
          }
        }
        saveMeta(chat);
      }
    }
  }

  pcLive(chat, proc);
  pcSwitchTick(chat, proc);

  // Claude's questions on the PC screen -> question card on the phone (a new card per question screen).
  const ask = status === 'waiting' && proc.tmux ? readAsk(paneOf(proc, project)) : null;
  if (ask && ask.key !== st.askKey) {
    if (st.permId) emit(chat, { t: 'permdone', id: st.permId, ok: true, why: st.askAnswer || 'answered on the PC' });
    st.permId = rid(); st.askKey = ask.key; st.askAnswer = null;
    if (ask.review) emit(chat, { t: 'perm', id: st.permId, tool: 'AskUserQuestion', title: ask.title, sum: ask.body, opts: ask.opts });
    else emit(chat, { t: 'perm', id: st.permId, tool: 'AskUserQuestion', pcask: true, tabs: ask.tabs, questions: [{ q: ask.q, multi: ask.multi, opts: ask.opts.map(({ l, d, checked }) => ({ l, d, checked })), other: !!ask.other }] });
  }
  if (!ask && st.askKey && status === 'waiting') {
    if (st.permId) emit(chat, { t: 'permdone', id: st.permId, ok: st.lastAnswer !== 'no', why: st.askAnswer || 'answered on the PC' });
    st.permId = null; st.askKey = null; st.askAnswer = null; st.lastAnswer = null;
  }
  // Approval waiting on the PC screen -> card on the phone.
  if (status === 'waiting' && !ask && !st.permId && proc.tmux) {
    const p = readPrompt(paneOf(proc, project));
    if (p && p.opts.length) {
      st.permId = rid();
      emit(chat, { t: 'perm', id: st.permId, tool: p.title, sum: p.body || p.question, title: p.title + (p.question ? ' · ' + p.question : ''), opts: p.opts });
    }
  }
  if (status !== 'waiting' && st.permId) {
    if (st.askKey) emit(chat, { t: 'permdone', id: st.permId, ok: st.lastAnswer !== 'no', why: st.lastAnswer === 'no' ? 'dismissed' : st.askAnswer || 'answered on the PC' });
    else emit(chat, { t: 'permdone', id: st.permId, ok: st.lastAnswer !== 'no', why: st.lastAnswer === 'no' ? 'denied' : 'pc' });
    st.permId = null; st.lastAnswer = null; st.askKey = null; st.askAnswer = null;
  }

  // Claude marks itself idle a moment before its last reply reaches the file: send "done" one tick later.
  if (st.doneNext) { st.doneNext = false; if (st.status === 'idle') emit(chat, { t: 'done' }); }
  const wasBusy = st.status === 'busy' || st.status === 'waiting';
  const isBusy = status === 'busy' || status === 'waiting';
  if (wasBusy && !isBusy) st.doneNext = true;
  if (status !== st.status) { st.status = status; broadcastMeta(chat); }
}

setInterval(() => { for (const p of Object.keys(PC_TMUX)) { try { pcTick(p); } catch (e) { log('pc tick', p, e.message); } } }, 300);


// ---------- live preview: words as the PC Claude types them ----------
// Claude writes a reply to its chat file only when that part is finished, but its screen shows every word.
// While it is busy, read the screen a few times a second and send the growing text to the phone.
// The finished, properly formatted reply then replaces the preview.
const norm = (t) => String(t || '').replace(/[*`_#>|\-\s•●⏺]/g, '');
function readLiveText(pane) {
  let lines;
  try { lines = tmux('capture-pane', '-p', '-J', '-t', pane, '-S', '-150').split('\n'); } catch { return null; }
  // cut the input box at the bottom (between two ──── lines)
  let i = lines.length - 1;
  while (i >= 0 && !/^\s*[─━]{8,}/.test(lines[i])) i--;
  i--;
  while (i >= 0 && !/^\s*[─━]{8,}/.test(lines[i])) i--;
  if (i < 0) return null;
  const body = lines.slice(0, i);
  // drop blank lines and the spinner line ("✽ Thinking… (esc to interrupt)") at the end
  while (body.length && (!body[body.length - 1].trim() || /…|esc to interrupt|tokens\)|^\s*[✻✽✶✳✢·*◐◓◑◒]\s/.test(body[body.length - 1]))) body.pop();
  const chunk = [];
  let sawBlank = false;
  for (let j = body.length - 1; j >= 0; j--) {
    const l = body[j];
    if (!l.trim()) sawBlank = true;
    if (/^❯\s/.test(l)) { if (!sawBlank) return null; break; }   // reached the user's own message: no reply text yet
    if (/^\s*⎿/.test(l) || /^\s{0,2}[●⏺]?\s*[A-Z][A-Za-z]+(\(|\s*\()/.test(l) && /\)\s*$|\(…/.test(l)) { if (!chunk.length) return null; break; } // tool step
    if (/^[●⏺]\s/.test(l)) { chunk.unshift(l.replace(/^[●⏺]\s/, '')); break; }
    chunk.unshift(l.replace(/^ {2}/, ''));
  }
  const text = chunk.join('\n').replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
  return text.trim() ? text : null;
}

function liveViewers(chat) { let n = 0; for (const ws of clients) if (ws.viewing === chat.meta.id) n++; return n; }

function sendLive(chat, msg) { for (const ws of clients) if (ws.viewing === chat.meta.id) send(ws, { op: 'live', chat: chat.meta.id, ...msg }); }

function pcLive(chat, proc) {
  const st = chat.pcState;
  if (!proc || proc.status !== 'busy' || !liveViewers(chat)) { if (st.live) { st.live = ''; sendLive(chat, { clear: true }); } return; }
  const text = readLiveText(paneOf(proc, chat.meta.project));
  if (!text || (st.lastFinal && st.lastFinal.startsWith(norm(text)))) { if (st.live) { st.live = ''; sendLive(chat, { clear: true }); } return; }
  if (text === st.live) return;
  if (st.live && text.startsWith(st.live)) sendLive(chat, { d: text.slice(st.live.length) });
  else sendLive(chat, { text });
  st.live = text;
}

// Make sure the tmux session exists and Claude runs in it (same as the `cl` command).
async function ensurePcClaude(project) {
  const name = PC_TMUX[project], dir = PROJECTS[project];
  try { tmux('has-session', '-t', name); } catch { tmux('new-session', '-d', '-s', name, '-c', dir); }
  if (pcProcess(project)) return true;
  if (tmux('display', '-p', '-t', name, '#{pane_current_command}').trim() === 'bash') {
    tmux('send-keys', '-t', name, '-l', `cd '${dir}' && { claude --continue || claude; }`);  // quoted: dir may have spaces; plain claude if no chat yet
    tmux('send-keys', '-t', name, 'Enter');
  }
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 500)); if (pcProcess(project)) { await new Promise((r) => setTimeout(r, 1500)); return true; } }
  return false;
}

async function pcSend(chat, text, cid) {
  events(chat);
  if (cid && chat.cids.has(cid)) return { ok: true };
  const project = chat.meta.project;
  const proc = pcProcess(project);
  if (proc && proc.status === 'waiting') return { ok: false, why: 'Claude on the PC is waiting for an approval. Answer it first.' };
  if (!(await ensurePcClaude(project))) return { ok: false, why: 'Could not start Claude on the PC.' };
  const name = paneOf(pcProcess(project), project);
  try { tmux('send-keys', '-t', name, '-X', 'cancel'); } catch {}
  const tmp = path.join(DATA, 'paste-' + rid());
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try {
    tmux('load-buffer', '-b', 'cm', tmp);
    tmux('paste-buffer', '-p', '-d', '-b', 'cm', '-t', name);
  } finally { fs.rmSync(tmp, { force: true }); }
  // Claude needs a moment to take in the paste before Enter. Answer the phone now, press Enter just after.
  setTimeout(() => { try { tmux('send-keys', '-t', name, 'Enter'); } catch (e) { log('pc enter', e.message); } }, 250);
  if (cid) chat.cids.add(cid);
  chat.pendingTexts.push(text.trim());
  if (chat.pendingTexts.length > 20) chat.pendingTexts.shift();
  emit(chat, { t: 'user', text, cid });
  return { ok: true };
}

function pcAnswer(chat, msg) {
  const st = chat.pcState;
  if (!st.permId || msg.id !== st.permId) return;
  const proc = pcProcess(chat.meta.project);
  if (!proc || proc.status !== 'waiting') return;
  const n = String(msg.n || '');
  if (!/^\d$/.test(n)) return;
  st.lastAnswer = msg.no ? 'no' : 'yes';
  tmux('send-keys', '-t', paneOf(proc, chat.meta.project), n);
}

// "claude:@0.%1" -> "%1": the exact tmux pane of that Claude.
function paneOf(proc, project) { const m = proc && proc.tmux && proc.tmux.match(/(%\d+)$/); return m ? m[1] : PC_TMUX[project]; }

// ---------- PC switches: mode (Shift+Tab), effort, model ----------
// The PC Claude shows its mode and effort on the bottom line of its screen; read them from there.
function readSwitches(pane) {
  let lines;
  try { lines = tmux('capture-pane', '-p', '-J', '-t', pane).split('\n').filter((l) => l.trim()); } catch { return null; }
  const bar = lines.slice(-3).join(' ');
  const mode = /auto mode on/i.test(bar) ? 'auto' : /accept edits on/i.test(bar) ? 'edits' : /plan mode on/i.test(bar) ? 'plan' : /bypass permissions on/i.test(bar) ? 'bypass' : 'manual';
  const e = bar.match(/[◐◑◒◓○●]\s*(low|medium|high|xhigh|max)\b/i);
  return { mode, effort: e ? e[1].toLowerCase() : null };
}
function pcSwitchTick(chat, proc) {
  const st = chat.pcState;
  if (!proc || !proc.tmux || st.status === 'waiting') return;
  if (Date.now() - (st.swAt || 0) < 1000) return;
  st.swAt = Date.now();
  const r = readSwitches(paneOf(proc, chat.meta.project));
  if (!r) return;
  if (r.mode !== st.mode || (r.effort && r.effort !== st.effort)) { st.mode = r.mode; if (r.effort) st.effort = r.effort; broadcastMeta(chat); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pcSetMode(chat, want) {
  if (!['manual', 'edits', 'plan', 'auto', 'bypass'].includes(want)) return 'Unknown mode.';
  const proc = pcProcess(chat.meta.project);
  if (!proc || !proc.tmux) return 'Claude is not running on the PC.';
  if (proc.status === 'waiting') return 'Answer the waiting approval first.';
  const pane = paneOf(proc, chat.meta.project);
  for (let i = 0; i < 7; i++) {
    const r = readSwitches(pane);
    if (r && r.mode === want) { chat.pcState.mode = want; broadcastMeta(chat); return null; }
    tmux('send-keys', '-t', pane, 'BTab');
    await sleep(350);
  }
  chat.pcState.swAt = 0;
  return 'That mode is not available in this Claude.';
}
// Slash commands with a value, typed into the PC Claude (only these, only when it is idle).
async function pcSlash(chat, cmd, val) {
  const ok = { effort: ['low', 'medium', 'high', 'xhigh', 'max'], model: ['opus', 'sonnet', 'haiku', 'fable'] };
  if (!ok[cmd] || !ok[cmd].includes(val)) return 'Not allowed.';
  const proc = pcProcess(chat.meta.project);
  if (!proc || !proc.tmux) return 'Claude is not running on the PC.';
  if (proc.status !== 'idle') return 'Wait until Claude is done, then switch.';
  const pane = paneOf(proc, chat.meta.project);
  try { tmux('send-keys', '-t', pane, '-X', 'cancel'); } catch {}
  tmux('send-keys', '-t', pane, '-l', `/${cmd} ${val}`);
  await sleep(300);
  tmux('send-keys', '-t', pane, 'Enter');
  if (cmd === 'model') chat.pcState.model = val;
  if (cmd === 'effort') chat.pcState.effort = val;
  chat.pcState.swAt = 0;
  broadcastMeta(chat);
  return null;
}

function pcStop(chat) {
  const proc = pcProcess(chat.meta.project);
  if (proc && proc.status !== 'idle') tmux('send-keys', '-t', paneOf(proc, chat.meta.project), 'Escape');
}


// ---------- file viewer (read-only, only inside the project folders) ----------
const HIDE = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.next', 'dist', 'build', '.cache']);
const SECRET = /(^|\/)(\.env[^/]*|.*\.(pem|key|p12|pfx|ppk|kdbx|jks|keystore)|id_(rsa|ed25519|ecdsa|dsa)[^/]*|credentials[^/]*|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.pgpass|\.htpasswd|token|.*\.kube\/config)$/i;
const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

function safePath(project, p) {
  const root = has(ROOTS, project) ? ROOTS[project] : null;
  if (!root) return null;
  let full = String(p || '').trim();
  if (full.startsWith('~/')) full = path.join(os.homedir(), full.slice(2));
  if (!path.isAbsolute(full)) full = path.join(root, full);
  let real;
  try { real = fs.realpathSync(full); } catch { return { err: 'File not found' }; }
  const roots = Object.values(ROOTS).map((r) => { try { return fs.realpathSync(r); } catch { return r; } });
  const inRoot = roots.find((r) => real === r || real.startsWith(r + path.sep));
  if (!inRoot) return { err: 'Only files inside your project folders and shared folders can be opened.' };
  const rel = path.relative(inRoot, real);
  const parts = rel.split(path.sep);
  if (parts.some((part) => HIDE.has(part))) return { err: 'This folder is hidden.' };
  if (SECRET.test(real)) return { err: 'Secret files are not shown on the phone.' };
  // Hidden (dot) folders hold settings, keys and start-up scripts. In a project they can still be read
  // by exact path, as before. In a wide place they are closed completely.
  const hasDot = parts.some((part) => part.startsWith('.') && part !== '.');
  if (WIDE.has(inRoot)) {
    if (!lockOn()) return { err: 'Turn on the fingerprint lock (in the menu) to open this folder.' };
    if (hasDot) return { err: 'Hidden folders are not shown on the phone.' };
  }
  return { real, root: inRoot, rel: rel || '.', hasDot };
}

function readFileFor(project, p) {
  const sp = safePath(project, p);
  if (!sp || sp.err) return { err: sp ? sp.err : 'Unknown project' };
  const st = fs.statSync(sp.real);
  if (st.isDirectory()) return listDir(project, p);
  if (!st.isFile()) return { err: 'This is not a regular file.' };
  const ext = path.extname(sp.real).toLowerCase();
  const base = { path: sp.real.replace(os.homedir(), '~'), rel: sp.rel, size: st.size, mtime: st.mtimeMs };
  if (IMG[ext]) {
    if (st.size > 4 * 1024 * 1024) return { ...base, err: 'Image is too big to send (over 4 MB).' };
    return { ...base, image: `data:${IMG[ext]};base64,` + fs.readFileSync(sp.real).toString('base64') };
  }
  const LIMIT = 600 * 1024;
  const fd = fs.openSync(sp.real, 'r');
  const buf = Buffer.alloc(Math.min(st.size, LIMIT));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  if (buf.subarray(0, 8000).includes(0)) return { ...base, err: 'This is not a text file.' };
  return { ...base, text: buf.toString('utf8'), truncated: st.size > LIMIT };
}

function listDir(project, p) {
  const sp = safePath(project, p || '.');
  if (!sp || sp.err) return { err: sp ? sp.err : 'Unknown project' };
  const items = [];
  for (const d of fs.readdirSync(sp.real, { withFileTypes: true })) {
    // Hidden names are not listed (a project still lists its .claude folder; a wide place lists none).
    if (HIDE.has(d.name) || (d.name.startsWith('.') && (d.name !== '.claude' || WIDE.has(sp.root)))) continue;
    const full = path.join(sp.real, d.name);
    if (SECRET.test(full)) continue;
    let st; try { st = fs.statSync(full); } catch { continue; }
    items.push({ n: d.name, d: st.isDirectory(), s: st.size, m: st.mtimeMs });
  }
  items.sort((a, b) => (b.d - a.d) || a.n.localeCompare(b.n));
  return { dir: true, path: sp.real.replace(os.homedir(), '~'), rel: sp.rel, items: items.slice(0, 500) };
}

// ---------- fingerprint lock (optional) ----------
// A passkey made on the phone. With the lock on, the phone's fingerprint, face or screen lock must
// approve each time the app is opened, and this computer checks the proof. So the key alone
// (a leaked link or QR code) is no longer enough to get in.
// Lost the phone? Delete data/passkeys.json and data/token on the computer, restart, pair again.
const PASSKEYS_FILE = path.join(DATA, 'passkeys.json');
let passkeys = [];
try { passkeys = JSON.parse(fs.readFileSync(PASSKEYS_FILE, 'utf8')); } catch {}
const savePasskeys = () => fs.writeFileSync(PASSKEYS_FILE, JSON.stringify(passkeys, null, 2), { mode: 0o600 });
const lockOn = () => passkeys.length > 0;
// How often to ask (config.json "lock"):
//   "rememberDays": 30   (default) ask once on a phone, then trust that phone for 30 days, also across
//                        restarts of this server. "Lock now" in the app ends it early.
//   "rememberDays": 0    strict: ask every time the app is opened, and after "afterMinutes" away (default 5).
const LOCK_CFG = CONFIG.lock || {};
const REMEMBER_DAYS = LOCK_CFG.rememberDays === undefined ? 30 : Math.max(0, Math.min(365, Number(LOCK_CFG.rememberDays) || 0));
const LOCK_AFTER_MS = Math.max(1, Number(LOCK_CFG.afterMinutes) || 5) * 60 * 1000;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
// A session is what an unlocked phone holds.
const sessions = new Map();   // sid -> { conns, exp }   (in memory)
// Phones that proved a fingerprint and are trusted until a date. Only a hash of each session is kept on disk.
const REMEMBER_FILE = path.join(DATA, 'remembered.json');
let remembered = new Map();   // sha256(sid) -> expiry time
try { remembered = new Map(Object.entries(JSON.parse(fs.readFileSync(REMEMBER_FILE, 'utf8'))).filter(([, e]) => e > Date.now())); } catch {}
const saveRemembered = () => { try { fs.writeFileSync(REMEMBER_FILE, JSON.stringify(Object.fromEntries(remembered)), { mode: 0o600 }); } catch {} };
const sidHash = (sid) => b64u(sha256(String(sid)));
const forgetAll = () => { remembered.clear(); saveRemembered(); };
if (!lockOn() && remembered.size) forgetAll();   // the lock was reset by hand: old trust must not come back with it
// proven = this phone just showed a fingerprint (an unlock, or making its passkey).
function newSession(proven) {
  const sid = crypto.randomBytes(24).toString('base64url');
  sessions.set(sid, { conns: 0, exp: Date.now() + LOCK_AFTER_MS, proven: !!proven });
  if (proven) rememberSession(sid);
  return sid;
}
function rememberSession(sid) {
  if (!REMEMBER_DAYS || !sid) return;
  remembered.set(sidHash(sid), Date.now() + REMEMBER_DAYS * 864e5); saveRemembered();
}
function forgetSession(sid) { if (!sid) return; sessions.delete(sid); if (remembered.delete(sidHash(sid))) saveRemembered(); }
function sessionOk(sid) {
  if (typeof sid !== 'string' || !sid || sid.length > 200) return false;
  if (REMEMBER_DAYS) {
    const h = sidHash(sid), e = remembered.get(h);
    if (e && e > Date.now()) { if (!sessions.has(sid)) sessions.set(sid, { conns: 0, exp: 0, proven: true }); return true; }
    if (e) { remembered.delete(h); saveRemembered(); }
  }
  const x = sessions.get(sid);
  if (!x) return false;
  // With the lock on, a session counts only if it was opened with a fingerprint. (One made while the
  // lock was still off must not carry over: that would let a leaked link stay in after the lock is turned on.)
  if (lockOn() && !x.proven) return false;
  if (x.conns > 0 || x.exp > Date.now()) return true;
  sessions.delete(sid); return false;
}
setInterval(() => {
  for (const [k, x] of sessions) if (!x.conns && x.exp < Date.now()) sessions.delete(k);
  let cut = false; for (const [h, e] of remembered) if (e < Date.now()) { remembered.delete(h); cut = true; }
  if (cut) saveRemembered();
}, 60000).unref();

// Check the phone's proof: signed by the saved passkey, for our fresh challenge, at the same address,
// and approved with fingerprint / face / screen lock (the "user verified" flag).
function verifyUnlock(msg, challenge) {
  const pk = passkeys.find((k) => k.id === msg.id);
  if (!pk || !challenge) return 'Unknown passkey';
  let ad, cd, sg, c;
  try {
    ad = Buffer.from(String(msg.authData), 'base64url'); cd = Buffer.from(String(msg.clientData), 'base64url'); sg = Buffer.from(String(msg.sig), 'base64url');
    c = JSON.parse(cd.toString('utf8'));
  } catch { return 'Bad data'; }
  if (c.type !== 'webauthn.get' || c.challenge !== challenge) return 'That check is out of date';
  if (c.crossOrigin === true) return 'Wrong address';
  if (c.origin !== pk.origin) return 'Wrong address';
  if (ad.length < 37 || !ad.subarray(0, 32).equals(sha256(pk.rpId))) return 'Wrong address';
  if (!(ad[32] & 0x01) || !(ad[32] & 0x04)) return 'The phone did not confirm it was you';
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(pk.pk, 'base64url'), format: 'der', type: 'spki' });
    if (!crypto.verify('sha256', Buffer.concat([ad, sha256(cd)]), key, sg)) return 'Bad signature';
  } catch { return 'Bad signature'; }
  // Signature counter: if the phone reports one, it must keep going up (a copied passkey would repeat it).
  const count = ad.readUInt32BE(33);
  if (count || pk.count) {
    if (count <= (pk.count || 0)) return 'This passkey looks copied';
    pk.count = count; savePasskeys();
  }
  return null;
}
// Close every connection that is no longer allowed in (after the lock was turned on, or "Lock now").
function kickUnproven(keepWs) {
  for (const c of clients) if (c !== keepWs && !sessionOk(c.sid)) { try { c.close(4002, 'locked'); } catch {} }
}
// Save a new passkey. Only an already unlocked phone can do this, so we trust the address it reports.
function addPasskey(msg, challenge) {
  let c;
  try { c = JSON.parse(Buffer.from(String(msg.clientData), 'base64url').toString('utf8')); } catch { return 'Bad data'; }
  if (c.type !== 'webauthn.create' || !challenge || c.challenge !== challenge) return 'That request is out of date';
  let host; try { host = new URL(c.origin).hostname; } catch { return 'Bad address'; }
  const rpId = String(msg.rpId || '');
  if (!rpId || (host !== rpId && !host.endsWith('.' + rpId))) return 'Bad address';
  if (![-7, -257].includes(msg.alg)) return 'This phone uses a kind of passkey that is not supported yet';
  try { crypto.createPublicKey({ key: Buffer.from(String(msg.pk), 'base64url'), format: 'der', type: 'spki' }); } catch { return 'Bad passkey'; }
  if (typeof msg.id !== 'string' || !msg.id || msg.id.length > 1024) return 'Bad passkey';
  passkeys = passkeys.filter((k) => k.id !== msg.id);
  passkeys.push({ id: msg.id, pk: String(msg.pk), alg: msg.alg, rpId, origin: c.origin, added: Date.now() });
  savePasskeys();
  log('lock', 'passkey added, lock is on');
  return null;
}

// "Wide" places: your home folder, or anything that contains it (like the whole disk). They can hold
// far more than a project does, so they only open while the fingerprint lock is on.
const realOf = (d) => { try { return fs.realpathSync(d); } catch { return path.resolve(d); } };
const HOME_REAL = realOf(os.homedir());
const WIDE = new Set(Object.values(ROOTS).map(realOf).filter((r) => r === HOME_REAL || HOME_REAL.startsWith(r.endsWith(path.sep) ? r : r + path.sep)));
for (const [name, d] of Object.entries(ROOTS)) if (WIDE.has(realOf(d))) log('note', `"${name}" covers your whole home folder or more: it opens only while the fingerprint lock is on`);

// ---------- terminal (optional, off unless config.json says "terminal": true) ----------
// Runs one command at a time in a project folder and sends back what it prints. This is a direct
// way to run anything on this computer, with no Claude and no approval card in between, so:
//   - it is off by default,
//   - it only works while the fingerprint lock is on,
//   - every command is written to the log.
// It starts in your home folder and remembers where "cd" took you. sudo works: the phone asks for the
// computer's password for that one command.
// It is not a full terminal: a command can't ask you questions, and it is stopped after 2 minutes.
const TERMINAL = CONFIG.terminal === true;
const RUN_MAX_MS = 120000, RUN_MAX_OUT = 300 * 1024;
const stripAnsi = (t) => t.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]|\r(?!\n)/g, '');
function terminalWhyNot() {
  if (!TERMINAL) return 'The terminal is turned off. To use it, set "terminal": true in config.json on the computer and restart.';
  if (!lockOn()) return 'Turn on the fingerprint lock (in the menu) to use the terminal.';
  return null;
}
// The folder a command runs in. The phone remembers where "cd" left it and sends that back each time.
const tilde = (d) => (d === HOME_REAL || d.startsWith(HOME_REAL + path.sep) ? '~' + d.slice(HOME_REAL.length) : d);
function runFolder(want) {
  try { const d = fs.realpathSync(expand(want || '~')); if (fs.statSync(d).isDirectory()) return d; } catch {}
  return HOME_REAL;
}
// sudo: the computer's password is typed on the phone for that one command. It is handed to sudo
// through a one-time file in memory (never the command line, the log or the output), and the file is
// removed as soon as sudo has read it, or when the command ends.
const ASKPASS = path.join(DATA, 'askpass.sh');
function sudoSetup(pw) {
  if (process.platform === 'win32' || typeof pw !== 'string' || !pw || pw.length > 500) return null;
  fs.writeFileSync(ASKPASS, '#!/bin/sh\n[ -f "$TETHER_PW_FILE" ] || exit 1\ncat "$TETHER_PW_FILE"\nrm -f "$TETHER_PW_FILE"\n', { mode: 0o700 });
  const dir = fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir();
  const file = path.join(dir, 'tether-' + crypto.randomBytes(12).toString('hex'));
  fs.writeFileSync(file, pw + '\n', { mode: 0o600, flag: 'wx' });
  return { file, env: { SUDO_ASKPASS: ASKPASS, TETHER_PW_FILE: file }, pre: 'sudo() { command sudo -A "$@"; }\n', done: () => fs.rmSync(file, { force: true }) };
}
const CWD_MARK = '\x1e__TETHER_CWD__';
function runCommand(ws, msg) {
  const why = terminalWhyNot();
  if (why) return send(ws, { op: 'run-end', rid: msg.rid, err: why });
  if (ws.run) return send(ws, { op: 'run-end', rid: msg.rid, err: 'Another command is still running.' });
  const cmd = String(msg.cmd || '').trim();
  if (!cmd || cmd.length > 4000) return send(ws, { op: 'run-end', rid: msg.rid, err: 'Empty or too long.' });
  const cwd = runFolder(msg.cwd);
  let sudo = null;
  try { sudo = sudoSetup(msg.pw); } catch (e) { return send(ws, { op: 'run-end', rid: msg.rid, err: 'Could not prepare sudo: ' + e.message }); }
  log('run', `[${tilde(cwd)}]`, cmd.slice(0, 300), sudo ? '(with sudo password)' : '');
  const t0 = Date.now();
  let sent = 0, done = false, held = '', newCwd = null;
  const win = process.platform === 'win32';
  // After the command, report the folder it ended in (so "cd" carries over to the next command).
  const script = win ? cmd : `${sudo ? sudo.pre : ''}${cmd}\n__t_rc=$?\nprintf '\\n\\036__TETHER_CWD__%s\\n' "$PWD"\nexit $__t_rc`;
  const child = win ? spawn(script, { shell: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('/bin/bash', ['-c', script], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', ...(sudo ? sudo.env : {}) } });
  const kill = () => { try { win ? child.kill() : process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const timer = setTimeout(() => { ws.runWhy = 'Stopped after 2 minutes.'; kill(); }, RUN_MAX_MS);
  ws.run = { rid: msg.rid, kill };
  const emit = (text) => {
    if (!text || sent >= RUN_MAX_OUT) return;
    if (sent + text.length > RUN_MAX_OUT) { text = text.slice(0, RUN_MAX_OUT - sent); ws.runWhy = 'Stopped: too much output.'; setTimeout(kill, 0); }
    sent += text.length;
    send(ws, { op: 'run-out', rid: msg.rid, d: text });
  };
  const out = (d) => {
    if (done || newCwd != null) return;
    held += stripAnsi(d.toString('utf8'));
    const at = held.indexOf('\n' + CWD_MARK);
    if (at >= 0) { newCwd = held.slice(at + 1 + CWD_MARK.length).split('\n')[0]; emit(held.slice(0, at)); held = ''; return; }
    // Keep back the last few characters: they might be the start of the folder marker.
    const keep = CWD_MARK.length + 1;
    if (held.length > keep) { emit(held.slice(0, -keep)); held = held.slice(-keep); }
  };
  child.stdout.on('data', out); child.stderr.on('data', out);
  const end = (code, signal, err) => {
    if (done) return;
    if (newCwd == null) emit(held);
    done = true; clearTimeout(timer); if (sudo) sudo.done();
    const note = ws.runWhy || (err ? 'Could not start: ' + err : null); ws.run = null; ws.runWhy = null;
    send(ws, { op: 'run-end', rid: msg.rid, code: code == null ? null : code, signal: signal || null, ms: Date.now() - t0, note, cwd: tilde(newCwd && fs.existsSync(newCwd) ? newCwd : cwd) });
  };
  child.on('error', (e) => end(null, null, e.message));
  child.on('close', (code, signal) => end(code, signal));
}

// ---------- this computer: CPU, memory, disk, battery (read-only) ----------
let cpuPrev = null;
function cpuSnap() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const t of Object.values(c.times)) total += t; idle += c.times.idle; }
  return { idle, total, at: Date.now() };
}
// Share of CPU in use since the last time someone asked (the phone asks every 2 s while the screen is open).
async function cpuPercent() {
  if (!cpuPrev || Date.now() - cpuPrev.at > 15000) { cpuPrev = cpuSnap(); await new Promise((r) => setTimeout(r, 300)); }
  const now = cpuSnap(), dt = now.total - cpuPrev.total, di = now.idle - cpuPrev.idle;
  if (now.at - cpuPrev.at >= 250) cpuPrev = now;
  return dt > 0 ? Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100))) : 0;
}
const readNum = (f) => { try { return Number(fs.readFileSync(f, 'utf8').trim()); } catch { return NaN; } };
function battery() {   // Linux only for now; other systems simply don't show it
  try {
    const dir = '/sys/class/power_supply';
    const bat = fs.readdirSync(dir).find((n) => /^BAT/i.test(n));
    if (!bat) return null;
    const pct = readNum(path.join(dir, bat, 'capacity'));
    if (!Number.isFinite(pct)) return null;
    return { pct, state: fs.readFileSync(path.join(dir, bat, 'status'), 'utf8').trim().toLowerCase() };
  } catch { return null; }
}
function temperature() {   // Linux only: the hottest sensor, in degrees C
  try {
    const dir = '/sys/class/thermal';
    const temps = fs.readdirSync(dir).filter((n) => n.startsWith('thermal_zone')).map((n) => readNum(path.join(dir, n, 'temp')) / 1000).filter((t) => t > 0 && t < 150);
    return temps.length ? Math.round(Math.max(...temps)) : null;
  } catch { return null; }
}
function disks() {
  const seen = new Set(), out = [];
  for (const [label, dir] of [['Home', os.homedir()], ...Object.entries(ROOTS)]) {
    try {
      const st = fs.statfsSync(dir), total = st.blocks * st.bsize, free = st.bavail * st.bsize;
      const key = total + ':' + st.blocks + ':' + st.files;   // same numbers = same disk
      if (!total || seen.has(key)) continue;
      seen.add(key); out.push({ label, total, used: total - free });
    } catch {}
  }
  return out;
}
function topProcesses() {
  return new Promise((resolve) => {
    const args = process.platform === 'linux' ? ['-eo', 'pcpu,pmem,comm', '--sort=-pcpu', '--no-headers']
      : process.platform === 'darwin' ? ['-Aceo', 'pcpu,pmem,comm', '-r'] : null;
    if (!args) return resolve([]);
    execFile('ps', args, { encoding: 'utf8', timeout: 2000 }, (e, out) => {
      if (e) return resolve([]);
      const rows = [];
      for (const line of out.split('\n')) {
        const m = line.trim().match(/^([\d.]+)\s+([\d.]+)\s+(.+)$/);
        if (m && m[3] !== 'ps') rows.push({ cpu: Number(m[1]), mem: Number(m[2]), name: m[3].slice(0, 40) });
        if (rows.length >= 6) break;
      }
      resolve(rows);
    });
  });
}
async function systemInfo() {
  const [cpu, procs] = await Promise.all([cpuPercent(), topProcesses()]);
  const total = os.totalmem(), free = os.freemem();
  let working = 0, waiting = 0;
  for (const c of chats.values()) { const m = chatSummary(c); if (m.waiting) waiting++; else if (m.busy) working++; }
  return {
    host: os.hostname(), os: { linux: 'Linux', darwin: 'macOS', win32: 'Windows' }[process.platform] || process.platform,
    cpu, cores: os.cpus().length, load: process.platform === 'win32' ? null : Math.round(os.loadavg()[0] * 100) / 100,
    mem: { total, used: total - free }, disks: disks(), battery: battery(), temp: temperature(),
    uptime: Math.round(os.uptime()), procs, claude: { working, waiting },
  };
}

// ---------- keep the computer awake (a switch in the app's Settings) ----------
// A computer that is asleep can't be reached by anything: nothing on it is running. So the only
// honest fix is to stop it sleeping. While the switch is on and the computer is plugged in, we hold
// the system's own "don't sleep" lock, which also covers closing a laptop lid. On battery we let
// go, so a laptop in a bag can still sleep instead of heating up.
const AWAKE_FILE = path.join(DATA, 'keep-awake');
let awakeWanted = fs.existsSync(AWAKE_FILE), awakeProc = null;
const AWAKE_TAG = '--who=Tether keep-awake';
function awakeCommand() {
  if (process.platform === 'linux') return ['systemd-inhibit', ['--what=sleep:idle:handle-lid-switch', AWAKE_TAG, '--why=Keep awake is on in the phone app', '--mode=block', 'sleep', 'infinity']];
  if (process.platform === 'darwin') return ['caffeinate', ['-ims']];   // not yet tested on a Mac; a closed lid still sleeps there
  return null;                                                            // Windows: not built yet
}
const onBattery = () => { const b = battery(); return !!(b && b.state === 'discharging'); };
function awakeSync() {
  const cmd = awakeCommand();
  const should = !!(awakeWanted && cmd && !onBattery());
  if (should && !awakeProc) {
    const p = spawn(cmd[0], cmd[1], { stdio: 'ignore' });
    awakeProc = p;
    const gone = () => { if (awakeProc === p) awakeProc = null; };
    p.on('exit', gone); p.on('error', (e) => { log('awake', 'could not hold the computer awake:', e.message); gone(); });
    log('awake', 'holding the computer awake');
  } else if (!should && awakeProc) { awakeProc.kill(); awakeProc = null; log('awake', 'released'); }
}
const awakeState = () => ({ supported: !!awakeCommand(), on: awakeWanted, active: !!awakeProc, onBattery: onBattery(), lid: process.platform === 'linux' });
// A lock left behind by an earlier run of this server would keep the computer awake for ever: clear it.
// (Matched from the start of the command line, so it can only ever hit our own lock process.)
if (process.platform === 'linux') { try { execFileSync('pkill', ['-f', '--', '^systemd-inhibit --what=sleep:idle:handle-lid-switch ' + AWAKE_TAG], { stdio: 'ignore' }); } catch {} }
setInterval(awakeSync, 30000).unref();
setTimeout(awakeSync, 500);

// ---------- websocket ----------
const clients = new Set();

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function broadcast(chat, ev) {
  const pub = publicEvent(ev);
  for (const ws of clients) {
    if (ws.viewing === chat.meta.id) send(ws, { op: 'ev', chat: chat.meta.id, evs: [pub] });
  }
  if (ev.t === 'user' || ev.t === 'done' || ev.t === 'perm' || ev.t === 'err') broadcastMeta(chat);
}

function broadcastMeta(chat) {
  const s = chatSummary(chat);
  for (const ws of clients) send(ws, { op: 'meta', chat: s });
}

function chatList() {
  return [...chats.values()].map(chatSummary).sort((a, b) => b.updated - a.updated).slice(0, 200);
}

async function handle(ws, msg) {
  const chat = msg.chat && chats.get(msg.chat);
  switch (msg.op) {
    case 'list': return send(ws, { op: 'list', chats: chatList(), projects: Object.keys(PROJECTS), folders: Object.keys(FOLDERS) });
    case 'open': {
      if (!chat) return send(ws, { op: 'gone', chat: msg.chat });
      ws.viewing = chat.meta.id;
      if (chat.pcState) chat.pcState.live = '';
      const since = Number(msg.since) || 0;
      // If the phone's copy is from an older server log, send everything again.
      // resetBelow: the saved log was cleaned up; phones with an older copy reload it once.
      events(chat); // load the log first so chat.seq is right
      const reset = since > chat.seq || (since > 0 && since < (chat.meta.resetBelow || 0));
      return send(ws, { op: 'ev', chat: chat.meta.id, evs: eventsSince(chat, reset ? 0 : since), reset, meta: chatSummary(chat) });
    }
    case 'new': {
      const c = newChat(has(PROJECTS, msg.project) ? msg.project : DEFAULT_PROJECT);
      ws.viewing = c.meta.id;
      broadcastMeta(c);
      return send(ws, { op: 'created', chat: chatSummary(c), rid: msg.rid });
    }
    case 'send': {
      if (!chat || !msg.text?.trim()) return;
      if (chat.meta.pc) {
        const r = await pcSend(chat, String(msg.text).slice(0, 100000), msg.cid);
        return send(ws, r.ok ? { op: 'ack', cid: msg.cid, chat: chat.meta.id } : { op: 'nack', cid: msg.cid, chat: chat.meta.id, why: r.why });
      }
      sendToChat(chat, String(msg.text).slice(0, 100000), msg.cid);
      return send(ws, { op: 'ack', cid: msg.cid, chat: chat.meta.id });
    }
    case 'perm': return chat?.meta.pc ? (chat.pcState.askKey && !String(chat.pcState.askKey).startsWith('review|') ? pcAsk(chat, msg) : pcAnswer(chat, msg)) : chat?.runner?.answer(msg.id, msg);
    case 'stop': return chat?.meta.pc ? pcStop(chat) : chat?.runner?.stop();
    case 'pcmode': {
      if (!chat?.meta.pc) return;
      const why = await pcSetMode(chat, String(msg.mode));
      if (why) send(ws, { op: 'toast', text: why });
      return;
    }
    case 'pcslash': {
      if (!chat?.meta.pc) return;
      const why = await pcSlash(chat, String(msg.cmd), String(msg.val));
      if (why) send(ws, { op: 'toast', text: why });
      return;
    }
    case 'full': {
      const ev = chat && events(chat).find((e) => e.t === 'tres' && e.id === msg.id);
      return send(ws, { op: 'full', chat: msg.chat, id: msg.id, text: ev ? (ev.full || ev.prev) : '' });
    }
    case 'rename': if (chat && msg.title) { chat.meta.title = String(msg.title).slice(0, 80); saveMeta(chat); broadcastMeta(chat); } return;
    case 'delete': {
      if (!chat || chat.meta.pc) return;
      chat.runner?.close();
      chats.delete(chat.meta.id);
      for (const p of [metaPath(chat.meta.id), logPath(chat.meta.id)]) fs.rmSync(p, { force: true });
      for (const c of clients) send(c, { op: 'gone', chat: chat.meta.id });
      return;
    }
    case 'file': {
      const project = has(ROOTS, msg.project) ? msg.project : DEFAULT_PROJECT;
      let r; try { r = msg.ls ? listDir(project, msg.path) : readFileFor(project, msg.path); } catch (e) { r = { err: e.message }; }
      return send(ws, { op: 'file', rid: msg.rid, project, ...r });
    }
    // Fingerprint lock: turn on (make a passkey on this phone), turn off, or lock right now.
    case 'lock-begin': {
      ws.enroll = b64u(crypto.randomBytes(32));
      return send(ws, { op: 'lock-begin', rid: msg.rid, challenge: ws.enroll, userId: b64u(crypto.randomBytes(16)) });
    }
    case 'lock-add': {
      // One passkey per lock for now. While the lock is on, a new one can't be added from the app at all:
      // that would let a stolen session plant a key that outlives "Lock now".
      if (lockOn()) { ws.enroll = null; return send(ws, { op: 'lock-state', rid: msg.rid, on: true, err: 'The lock is already on. To set it up again, turn it off first.' }); }
      const why = addPasskey(msg, ws.enroll);
      ws.enroll = null;
      if (!why) {
        const x = sessions.get(ws.sid); if (x) x.proven = true;
        rememberSession(ws.sid);   // this phone just proved itself by making its passkey
        kickUnproven(ws);          // anyone else who got in with only the key is now out
      }
      return send(ws, { op: 'lock-state', rid: msg.rid, on: lockOn(), err: why || undefined });
    }
    // Turning the lock off needs a fresh fingerprint, not just an old session.
    case 'lock-reauth': {
      ws.reauth = b64u(crypto.randomBytes(32));
      return send(ws, { op: 'lock-reauth', rid: msg.rid, challenge: ws.reauth, ids: passkeys.map((k) => k.id) });
    }
    case 'lock-off': {
      if (lockOn()) {
        const why = verifyUnlock(msg.proof || {}, ws.reauth);
        ws.reauth = null;
        if (why) { log('lock', 'turn-off refused:', why); return send(ws, { op: 'lock-state', rid: msg.rid, on: true, err: why }); }
      }
      passkeys = []; savePasskeys(); forgetAll(); log('lock', 'turned off');
      return send(ws, { op: 'lock-state', rid: msg.rid, on: false });
    }
    case 'lock-now': {
      const sid = ws.sid; forgetSession(sid);
      for (const c of clients) if (c.sid === sid) { c.sid = null; try { c.close(4002, 'locked'); } catch {} }
      return;
    }
    case 'awake': {
      awakeWanted = !!msg.on;
      try { awakeWanted ? fs.writeFileSync(AWAKE_FILE, '1', { mode: 0o600 }) : fs.rmSync(AWAKE_FILE, { force: true }); } catch {}
      awakeSync();
      await new Promise((r) => setTimeout(r, 250));   // give the lock a moment to start, or fail
      return send(ws, { op: 'awake', rid: msg.rid, ...awakeState() });
    }
    case 'run': return runCommand(ws, msg);
    case 'run-stop': { if (ws.run) { ws.runWhy = 'Stopped.'; ws.run.kill(); } return; }
    case 'sys': {
      let r; try { r = await systemInfo(); } catch (e) { r = { err: e.message }; }
      return send(ws, { op: 'sys', rid: msg.rid, ...r });
    }
    case 'ping': return send(ws, { op: 'pong', t: msg.t });
    // Test notifications: one device asks, every other device shows one and reports back.
    case 'notify': { let n = 0; for (const c of clients) if (c !== ws && c.authed !== false) { send(c, { op: 'notify', title: String(msg.title || 'Claude').slice(0, 60), body: String(msg.body || '').slice(0, 120) }); n++; } log('test notify sent to', n, 'device(s)'); return send(ws, { op: 'notified', n }); }
    case 'notify-ack': log('notify result:', JSON.stringify(msg.r).slice(0, 200)); for (const c of clients) if (c !== ws) send(c, { op: 'notify-ack', r: msg.r }); return;
  }
}

// ---------- static files (precompressed, cached on the phone) ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/manifest+json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const assets = new Map();
function loadAssets() {
  assets.clear();
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { walk(p); continue; }
      const body = fs.readFileSync(p);
      const rel = '/' + path.relative(PUBLIC, p).split(path.sep).join('/');
      const type = TYPES[path.extname(p)] || 'application/octet-stream';
      const text = /^(text|application\/(manifest|json))|svg/.test(type);
      assets.set(rel, {
        type, body,
        br: text ? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }) : null,
        gz: text ? zlib.gzipSync(body, { level: 9 }) : null,
        etag: '"' + crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16) + '"',
      });
    }
  };
  walk(PUBLIC);
}
loadAssets();
fs.watch(PUBLIC, { recursive: true }, () => { clearTimeout(loadAssets.t); loadAssets.t = setTimeout(loadAssets, 200); });

// ---------- phone <-> PC files (attach, voice notes, download) ----------
// Attachments land in <uploads>/<date>/ and the message tells Claude their full path.
const UPLOADS = CONFIG.uploads ? expand(CONFIG.uploads) : path.join(os.homedir(), 'Downloads', 'tether-uploads');
// Voice notes are optional: they need Python with faster-whisper (see README). "voice.python" in config.json.
const VOICE = CONFIG.voice || {};
const STT_PY = process.env.STT_PY || (VOICE.python ? expand(VOICE.python) : 'python3');
const STT_ENV = { ...process.env, HF_HUB_OFFLINE: '1', STT_HINTS: VOICE.hints || '', STT_MODEL: VOICE.model || 'small' };
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { reject(new Error('too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
// ---------- live voice (v26): the phone streams 1s pieces while recording ----------
// stt_worker.py keeps Whisper loaded and transcribes each finished sentence while you are still talking,
// so after the mic stops only the last few seconds are left (61s test note: 41s before -> ~2s).
const LIVE = new Map();    // sid -> { file, busy, dirty, ending, text, waiters, next, t }
let sttProc = null;
const sttWait = new Map(); // sid -> resolve for that session's one in-flight job
function sttWorker() {
  if (sttProc && sttProc.exitCode === null) return sttProc;
  const p = spawn(STT_PY, [path.join(ROOT, 'stt_worker.py')], { stdio: ['pipe', 'pipe', 'pipe'], env: STT_ENV });
  sttProc = p;
  readline.createInterface({ input: p.stdout }).on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.ready) return log('stt', 'worker ready');
    const w = m.id && sttWait.get(m.id);
    if (w) { sttWait.delete(m.id); w(m); }
  });
  p.stderr.on('data', (d) => { const s = String(d).trim(); if (s && !/warn/i.test(s)) log('stt', s.slice(0, 300)); });
  p.on('error', (e) => log('stt', 'worker error', e.message));
  p.on('exit', (c) => { log('stt', 'worker exit', c); if (sttProc === p) { for (const [k, w] of sttWait) w({ id: k, err: 'worker stopped' }); sttWait.clear(); } });
  return p;
}
function sttJob(sid, file, final) {
  return new Promise((resolve) => {
    const p = sttWorker();
    sttWait.set(sid, resolve);
    p.stdin.write(JSON.stringify({ id: sid, path: file, final }) + '\n');
    setTimeout(() => { if (sttWait.get(sid) === resolve) { sttWait.delete(sid); resolve({ id: sid, err: 'timeout' }); } }, 120000);
  });
}
async function livePump(sid) {
  const s = LIVE.get(sid);
  if (!s || s.busy) return;
  s.busy = true;
  while (s.dirty && !s.ending) {
    s.dirty = false;
    const r = await sttJob(sid, s.file, false);
    if (typeof r.text === 'string') s.text = r.text;
  }
  s.busy = false;
  const ws = s.waiters; s.waiters = []; ws.forEach((f) => f());
}
async function liveEnd(sid) {
  const s = LIVE.get(sid);
  if (!s) return { err: 'Unknown recording' };
  s.ending = true;
  if (s.busy) await new Promise((r) => s.waiters.push(r));
  const r = await sttJob(sid, s.file, true);
  LIVE.delete(sid); fs.rmSync(s.file, { force: true });
  return r;
}
setInterval(() => { // recordings the phone abandoned (lost signal, app killed)
  const now = Date.now();
  for (const [sid, s] of LIVE) if (now - s.t > 10 * 60000 && !s.busy) { LIVE.delete(sid); fs.rmSync(s.file, { force: true }); sttProc?.stdin.write(JSON.stringify({ id: sid, drop: true }) + '\n'); }
}, 60000).unref();
// Voice is optional: only warm the model up when voice is set up (config.json "voice" or STT_PY).
if (VOICE.python || process.env.STT_PY) setTimeout(() => { try { sttWorker(); } catch (e) { log('stt', e.message); } }, 3000); // load the model at start, not on the first note

function cleanName(n) {
  const base = path.basename(String(n || 'file')).replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return base || 'file';
}
function jsonRes(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(obj)); }
async function api(req, res, url) {
  if (!tokenOk(req.headers['x-token'])) return jsonRes(res, 401, { err: 'Wrong key' });
  if (lockOn() && !sessionOk(req.headers['x-session'])) return jsonRes(res, 401, { err: 'Locked. Open the app and unlock it first.' });
  try {
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      // Two kinds: a file attached to a message (goes to the uploads folder), or a file put into a
      // project folder from the Files screen (?project=..&dir=..). Never overwrites: a number is added.
      let dir, mode = 0o600;
      const project = url.searchParams.get('project');
      if (project) {
        const sp = safePath(project, url.searchParams.get('dir') || '.');
        if (!sp || sp.err) return jsonRes(res, 404, { err: sp ? sp.err : 'Unknown project' });
        if (!fs.statSync(sp.real).isDirectory()) return jsonRes(res, 400, { err: 'Not a folder' });
        // Never write into hidden folders: that is where start-up scripts and tool settings live.
        if (sp.hasDot) return jsonRes(res, 400, { err: 'Files can\'t be uploaded into hidden folders.' });
        dir = sp.real; mode = 0o644;
      } else {
        const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        dir = path.join(UPLOADS, day);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      let name = cleanName(url.searchParams.get('name')), f = path.join(dir, name), i = 1;
      if (project && (name.startsWith('.') || SECRET.test(f))) return jsonRes(res, 400, { err: 'That file name is not allowed here.' });
      const body = await readBody(req, 50 * 1024 * 1024);
      while (fs.existsSync(f)) { const e = path.extname(name); f = path.join(dir, path.basename(name, e) + `-${++i}` + e); }
      fs.writeFileSync(f, body, { mode, flag: 'wx' });
      log('upload', f, body.length);
      return jsonRes(res, 200, { path: f, name: path.basename(f), size: body.length });
    }
    if (req.method === 'POST' && url.pathname === '/api/voice') {
      const body = await readBody(req, 20 * 1024 * 1024);
      const dir = path.join(UPLOADS, 'voice');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const f = path.join(dir, rid() + '.webm');
      fs.writeFileSync(f, body, { mode: 0o600 });
      try {
        // async: speech-to-text takes a few seconds and must not freeze the live chats
        const out = await new Promise((ok, bad) => execFile(STT_PY, [path.join(ROOT, 'stt.py'), f], { encoding: 'utf8', timeout: 180000, env: STT_ENV }, (e, so) => (e ? bad(e) : ok(so))));
        return jsonRes(res, 200, JSON.parse(out.trim().split('\n').pop()));
      } finally { fs.rmSync(f, { force: true }); }
    }
    if (req.method === 'POST' && (url.pathname === '/api/voice/chunk' || url.pathname === '/api/voice/end')) {
      const sid = String(url.searchParams.get('sid') || '');
      const seq = Number(url.searchParams.get('seq'));
      if (!/^[\w-]{8,40}$/.test(sid)) return jsonRes(res, 400, { err: 'Bad recording id' });
      const body = await readBody(req, 5 * 1024 * 1024);
      let s = LIVE.get(sid);
      if (!s) {
        if (seq !== 0) return jsonRes(res, 409, { err: 'Recording lost on the PC', lost: true });
        const dir = path.join(UPLOADS, 'voice');
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        s = { file: path.join(dir, `live-${sid}.webm`), busy: false, dirty: false, ending: false, text: '', waiters: [], next: 0, t: Date.now() };
        fs.writeFileSync(s.file, Buffer.alloc(0), { mode: 0o600 });
        LIVE.set(sid, s);
      }
      s.t = Date.now();
      if (Number.isInteger(seq) && seq >= 0 && seq >= s.next) {
        if (seq > s.next) return jsonRes(res, 409, { err: 'A piece of the recording is missing', lost: true });
        if (body.length) { fs.appendFileSync(s.file, body); s.dirty = true; }
        s.next++;
      } // seq < next: a resend of a piece already stored, ignore it
      if (url.pathname === '/api/voice/end') {
        const r = await liveEnd(sid);
        if (r.err) return jsonRes(res, 500, { err: 'Voice note failed on the PC' });
        return jsonRes(res, 200, { text: r.text || '', lang: r.lang });
      }
      livePump(sid);
      return jsonRes(res, 200, { text: s.text, next: s.next });
    }
    if (req.method === 'GET' && url.pathname === '/api/dl') {
      const sp = safePath(url.searchParams.get('project'), url.searchParams.get('path'));
      if (!sp || sp.err) return jsonRes(res, 404, { err: sp ? sp.err : 'Unknown project' });
      const st = fs.statSync(sp.real);
      if (!st.isFile()) return jsonRes(res, 400, { err: 'Not a file' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${cleanName(path.basename(sp.real))}"` });
      return fs.createReadStream(sp.real).pipe(res);
    }
  } catch (e) { log('api', url.pathname, e.message); return jsonRes(res, e.message === 'too big' ? 413 : 500, { err: e.message === 'too big' ? 'File is too big' : 'Failed on the PC' }); }
  return jsonRes(res, 404, { err: 'Not found' });
}

// The app's own socket address, for the page's security policy (older Safari doesn't count wss: as 'self').
function cspSocket(req) {
  const h = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return /^[\w.-]+(:\d+)?$/.test(h) ? ` wss://${h} ws://${h}` : '';
}
function serve(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const a = assets.get(p);
  const sec = {
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'self'; connect-src 'self'${cspSocket(req)}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
  if (!a) { res.writeHead(404, sec); return res.end('Not found'); }
  if (req.headers['if-none-match'] === a.etag) { res.writeHead(304, { ...sec, ETag: a.etag }); return res.end(); }
  const ae = String(req.headers['accept-encoding'] || '');
  const headers = { ...sec, 'Content-Type': a.type, ETag: a.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
  let body = a.body;
  if (a.br && ae.includes('br')) { body = a.br; headers['Content-Encoding'] = 'br'; }
  else if (a.gz && ae.includes('gzip')) { body = a.gz; headers['Content-Encoding'] = 'gzip'; }
  if (p === '/sw.js') headers['Service-Worker-Allowed'] = '/';
  res.writeHead(200, headers);
  res.end(body);
}

// ---------- start ----------
loadChats();
for (const [id, c] of chats) if (c.meta.imported) { chats.delete(id); fs.rmSync(metaPath(id), { force: true }); fs.rmSync(logPath(id), { force: true }); }
for (const p of Object.keys(PC_TMUX)) pcChat(p);
for (const host of HOSTS) {
  const server = http.createServer(serve);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2 * 1024 * 1024, perMessageDeflate: { threshold: 256 } });
  wss.on('connection', (ws, req) => {
    // Only pages served by this app may connect (a web page on another site can't open a socket here).
    const origin = req.headers.origin;
    if (origin) {
      let oh = ''; try { oh = new URL(origin).host; } catch {}
      const okHosts = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).map((h) => String(h).split(',')[0].trim());
      if (!oh || !okHosts.includes(oh)) { logLimited('blocked a connection from another site:', origin.slice(0, 80)); return ws.close(4003, 'origin'); }
    }
    ws.authed = false;
    ws.missed = 0;
    ws.on('pong', () => (ws.missed = 0));
    ws.on('message', () => (ws.missed = 0));
    const authTimer = setTimeout(() => ws.close(4001, 'auth'), 5000);
    ws.on('message', async (raw) => {
      if (ws.refused) return;
      // Before sign-in only small messages are read (a hello or an unlock is well under 4 KB).
      if (!ws.authed && raw.length > 4096) { ws.refused = true; return ws.close(4003, 'too big'); }
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!ws.authed) {
        const admit = (sid) => {
          ws.authed = true; ws.sid = sid; sessions.get(sid).conns++; clearTimeout(ws.lockTimer); clients.add(ws);
          send(ws, { op: 'welcome', chats: chatList(), projects: Object.keys(PROJECTS), folders: Object.keys(FOLDERS), host: os.hostname(), sid, lock: lockOn(), lockAfter: LOCK_AFTER_MS, rememberDays: REMEMBER_DAYS, terminal: TERMINAL, awake: awakeState(),
            // Folder of each project and shared folder, for the terminal's "cd" shortcuts.
            dirs: TERMINAL ? Object.fromEntries(Object.entries(ROOTS).filter(([, d]) => realOf(d) !== HOME_REAL).map(([n, d]) => [n, tilde(realOf(d))])) : undefined });
        };
        const askUnlock = (err) => {
          ws.challenge = b64u(crypto.randomBytes(32));
          send(ws, { op: 'lock', challenge: ws.challenge, ids: passkeys.map((k) => k.id), err });
        };
        if (!ws.keyOk) {
          if (msg.op === 'hello' && tokenOk(msg.token)) {
            ws.keyOk = true; clearTimeout(authTimer);
            if (!lockOn()) return admit(sessionOk(msg.sid) ? msg.sid : newSession());
            if (sessionOk(msg.sid)) return admit(msg.sid);
            // Locked: give the person two minutes to use their fingerprint, then hang up.
            ws.lockTimer = setTimeout(() => ws.close(4001, 'locked'), 120000);
            return askUnlock();
          }
          logLimited('bad key from', req.socket.remoteAddress);
          ws.refused = true;   // one try per connection
          setTimeout(() => ws.close(4003, 'bad token'), 1000);
          return;
        }
        if (msg.op === 'unlock') {
          ws.tries = (ws.tries || 0) + 1;
          const why = verifyUnlock(msg, ws.challenge);
          ws.challenge = null;   // each challenge works once
          if (!why) return admit(newSession(true));
          log('lock', 'unlock refused:', why);
          if (ws.tries >= 5) return ws.close(4001, 'locked');
          return askUnlock(why);
        }
        return;
      }
      try { await handle(ws, msg); } catch (e) { log('handle error', msg.op, e.message); send(ws, { op: 'error', msg: e.message }); }
    });
    ws.on('close', () => {
      clients.delete(ws); clearTimeout(authTimer); clearTimeout(ws.lockTimer);
      if (ws.run) ws.run.kill();   // the phone went away: don't leave its command running
      const x = ws.sid && sessions.get(ws.sid);
      if (x) { x.conns = Math.max(0, x.conns - 1); x.exp = Date.now() + LOCK_AFTER_MS; }
    });
    ws.on('error', () => {});
  });
  setInterval(() => {
    for (const ws of wss.clients) {
      // Phone may sit in another app for a while (Android freezes it): allow 24 missed
      // pongs (~10 min) before dropping (v28, was ~75s), so the same connection survives longer breaks.
      if (ws.missed >= 24) { ws.terminate(); continue; }
      ws.missed++; try { ws.ping(); } catch {}
    }
  }, 25000);
  // Tailscale may come up after us at boot: keep retrying until its IP exists.
  server.on('error', (e) => { log('listen error on', host, e.code, '- retrying in 5s'); setTimeout(() => server.listen(PORT, host), 5000); });
  server.listen(PORT, host, () => log(`Tether on http://${host}:${PORT}`));
}

process.on('unhandledRejection', (e) => log('unhandled', e?.message || e));
const shutdown = () => { if (awakeProc) { try { awakeProc.kill(); } catch {} } for (const c of chats.values()) c.runner?.close(); setTimeout(() => process.exit(0), 300); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
