// Tether client. Plain JS, no framework: small download, fast on the phone.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = window.escapeHtml;
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const buzz = (ms = 8) => { try { navigator.vibrate && navigator.vibrate(ms); } catch {} };
  const coarse = matchMedia('(pointer: coarse)').matches;
  const APP = 'Tether', VERSION = '0.1.0';
  // iPadOS reports itself as a Mac, so also check for touch.
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const root = document.documentElement;
  root.classList.add(ios ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : 'desktop');
  const wide = matchMedia('(min-width: 900px)');   // tablets and desktops: the chat list stays open on the left

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('cm:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('cm:' + k, JSON.stringify(v)); } catch (e) { trimCache(); } },
    del(k) { localStorage.removeItem('cm:' + k); },
  };
  function trimCache() {
    // Storage full: drop cached history of the oldest chats (server still has it).
    const ids = [...S.chats.values()].sort((a, b) => a.updated - b.updated).map((c) => c.id);
    for (const id of ids.slice(0, Math.ceil(ids.length / 2))) if (id !== S.cur) store.del('ev:' + id);
  }

  // Key can arrive in the link once: https://pc/#k=KEY
  if (location.hash.startsWith('#k=')) {
    store.set('token', decodeURIComponent(location.hash.slice(3)));
    history.replaceState(null, '', location.pathname);
  }

  const S = {
    token: store.get('token', ''),
    sid: store.get('sid', null),           // fingerprint lock: this phone's remembered session, if any
    ws: null, online: false, everOnline: false, tries: 0, lastIn: 0, timer: null,
    chats: new Map((store.get('chats', [])).map((c) => [c.id, c])),
    atts: [],
    projects: store.get('projects', []),
    folders: store.get('folders', []),      // extra places for the Files screen (config.json "folders")
    project: store.get('project', ''),
    cur: store.get('cur', null),
    outbox: store.get('outbox', []),
    cache: null,           // { seq, evs } for the open chat
    atBottom: true,
    busySince: 0,
    thinking: false,
  };

  // ---------- DOM refs ----------
  const log = $('log'), msgs = $('msgs'), input = $('input'), sendBtn = $('sendBtn'), stopBtn = $('stopBtn');
  const working = $('working'), workingText = $('workingText'), jump = $('jump'), banner = $('banner');

  // ---------- connection ----------
  function wsUrl() { return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'; }

  function connect() {
    if (!S.token) return showSetup();
    if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;
    clearTimeout(S.timer);
    setConn('wait');
    let ws;
    try { ws = new WebSocket(wsUrl()); } catch { return retry(); }
    S.ws = ws;
    ws.onopen = () => { ws.send(JSON.stringify({ op: 'hello', token: S.token, sid: S.sid || undefined })); };
    ws.onmessage = (e) => { S.lastIn = Date.now(); let m; try { m = JSON.parse(e.data); } catch { return; } onMsg(m); };
    ws.onclose = (e) => {
      if (S.ws !== ws) return;
      S.ws = null; S.online = false;
      if (e.code === 4003) { setConn('off'); return showSetup('That key was not accepted.'); }
      if (e.code === 4002) { S.sid = null; store.del('sid'); }   // "Lock now": the next connection asks for the fingerprint
      setConn(navigator.onLine === false ? 'off' : 'wait');
      retry();
    };
    ws.onerror = () => {};
  }

  function retry() {
    clearTimeout(S.timer);
    const delay = Math.min(5000, 400 * Math.pow(1.7, S.tries++));
    S.timer = setTimeout(connect, delay);
  }

  // The key, plus the unlocked session when the fingerprint lock is on.
  function hdr() { const h = { 'X-Token': S.token }; if (S.sid) h['X-Session'] = S.sid; return h; }

  function wsSend(obj) {
    if (S.ws && S.ws.readyState === 1 && S.online) { S.ws.send(JSON.stringify(obj)); return true; }
    return false;
  }

  // Detect dead connections fast (mobile networks often drop silently).
  setInterval(() => {
    if (!S.ws || S.ws.readyState !== 1) return;
    if (Date.now() - S.lastIn > 40000) { try { S.ws.close(); } catch {} S.ws = null; S.online = false; setConn('wait'); connect(); return; }
    wsSend({ op: 'ping', t: Date.now() });
  }, 15000);

  // Drop the current socket without triggering the slow retry path, then dial again now.
  function redial() {
    const old = S.ws;
    S.ws = null; S.online = false; S.tries = 0;
    if (old) { old.onclose = null; old.onmessage = null; try { old.close(); } catch {} }
    connect();
  }

  function poke(wait = 4000) {
    if (!S.ws || S.ws.readyState > 1) { S.tries = 0; clearTimeout(S.timer); connect(); return; }
    const before = S.lastIn, ws = S.ws;
    wsSend({ op: 'ping', t: Date.now() });
    setTimeout(() => { if (S.lastIn === before && S.ws === ws) redial(); }, wait);
  }

  // Coming back from another app:
  // - away up to 10 min (v28; was 30s): keep the same connection and change nothing on screen. A quiet
  //   ping checks it; only if that fails do we redial, still quietly.
  // - away over 10 min: start a fresh connection right away, quietly.
  // "Quietly" = for a few seconds the dot, header and banner keep looking connected;
  // they only show "Reconnecting" if the PC still isn't back after that.
  const KEEP_MS = 10 * 60 * 1000, QUIET_MS = 5000;  // v28: try the same connection after up to 10 min away (was 30s)
  let hiddenAt = 0;
  S.resumeUntil = 0;
  function quiet() {
    S.resumeUntil = Date.now() + QUIET_MS;
    clearTimeout(quiet.t);
    quiet.t = setTimeout(() => setConn(S.online ? 'on' : navigator.onLine === false ? 'off' : 'wait'), QUIET_MS + 100);
  }
  function onBack() {
    document.title = APP;
    if (!hiddenAt) return;
    const away = Date.now() - hiddenAt;
    hiddenAt = 0;
    // Fingerprint lock: after a while away, opening the app asks again.
    // (Only in strict mode. By default the phone is remembered for a number of days.)
    if (S.lockOn && !S.rememberDays && away > (S.lockAfter || 300000)) { S.sid = null; return redial(); }
    quiet();
    if (away > KEEP_MS || !S.ws || S.ws.readyState > 1) redial();
    else poke(4000);
  }
  addEventListener('online', () => poke(4000));
  addEventListener('offline', () => setConn('off'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) hiddenAt = Date.now(); else onBack(); });
  document.addEventListener('resume', () => { if (!document.hidden) onBack(); });
  addEventListener('pageshow', (e) => { if (e.persisted) onBack(); });

  function setConn(state) {
    const dot = $('dot');
    const shown = state !== 'on' && Date.now() < S.resumeUntil ? 'on' : state;
    dot.className = 'dot ' + (shown === 'on' ? 'on' : shown === 'off' ? 'off' : 'wait');
    root.classList.toggle('online', shown === 'on');   // the mark's dot goes green while the link is up
    updateHeader();
    updateBanner();
  }

  // ---------- server messages ----------
  function onMsg(m) {
    switch (m.op) {
      case 'lock': showLock(m); break;
      case 'welcome': {
        S.online = true; S.everOnline = true; S.tries = 0;
        S.sid = m.sid || null; S.lockOn = !!m.lock; S.lockAfter = m.lockAfter; S.rememberDays = m.rememberDays || 0; store.set('lockOn', S.lockOn);
        // Keep the session on the phone only when the computer remembers phones; strict mode asks on every open.
        if (S.lockOn && S.rememberDays && S.sid) store.set('sid', S.sid); else store.del('sid');
        $('termBtn').hidden = !m.terminal;
        showAwake(m.awake);
        S.dirs = m.dirs || {};
        hideLock(); showLockRow();
        hideSetup();
        S.projects = m.projects; store.set('projects', m.projects);
        S.folders = m.folders || []; store.set('folders', S.folders);
        if (!S.projects.includes(S.project)) { S.project = S.projects[0] || ''; store.set('project', S.project); }
        setChats(m.chats);
        $('foot').textContent = 'Connected to ' + m.host + ' · v' + VERSION;
        updateEmpty();
        setConn('on');
        if (S.cur && !isTmp(S.cur)) {
          if (S.chats.has(S.cur)) openOnServer(S.cur);
          else { S.cur = null; showChat(null); }
        }
        flushOutbox();
        break;
      }
      case 'list': setChats(m.chats); break;
      case 'toast': toastLine(m.text); break;
      case 'meta': {
        S.chats.set(m.chat.id, m.chat);
        saveChats();
        if (m.chat.id === S.cur) { updateHeader(); updateBusy(); }
        if (drawerShown()) renderDrawer();
        if (m.chat.waiting && m.chat.id !== S.cur) notify('Claude needs your approval', m.chat.title);
        break;
      }
      case 'ev': {
        if (m.chat !== S.cur) return;
        if (m.meta) { S.chats.set(m.chat, m.meta); saveChats(); updateHeader(); }
        if (m.reset) { S.cache = { seq: 0, evs: [] }; msgs.innerHTML = ''; resetRenderState(); }
        let changed = false;
        for (const ev of m.evs) {
          if (ev.seq <= S.cache.seq) continue;
          S.cache.seq = ev.seq;
          cachePush(ev);
          apply(ev, true);
          changed = true;
        }
        if (changed) { saveCache(); afterRender(); }
        updateBusy();
        break;
      }
      case 'created': {
        S.chats.set(m.chat.id, m.chat); saveChats();
        if (m.rid && isTmp(m.rid)) {
          // A chat started offline now exists on the PC: move everything over.
          for (const it of S.outbox) if (it.chat === m.rid) { it.chat = m.chat.id; it.creating = false; }
          saveOutbox();
          const c = store.get('ev:' + m.rid, null);
          if (c) { store.set('ev:' + m.chat.id, c); store.del('ev:' + m.rid); }
          S.chats.delete(m.rid);
          if (S.cur === m.rid) { S.cur = m.chat.id; store.set('cur', S.cur); }
          if (S.cur === m.chat.id) openOnServer(S.cur);
          flushOutbox();
        } else {
          showChat(m.chat.id);
        }
        break;
      }
      case 'ack': {
        S.outbox = S.outbox.filter((it) => it.cid !== m.cid); saveOutbox();
        const b = msgs.querySelector(`.msg-user[data-cid="${CSS.escape(String(m.cid))}"]`);
        if (b) markSent(b);
        updateBanner();
        break;
      }
      case 'nack': {
        S.outbox = S.outbox.filter((it) => it.cid !== m.cid); saveOutbox();
        const b = msgs.querySelector(`.msg-user[data-cid="${CSS.escape(String(m.cid))}"]`);
        if (b) { const st = b.querySelector('.state'); if (st) st.textContent = 'Not sent: ' + m.why; }
        updateBanner();
        break;
      }
      case 'live': {
        if (m.chat !== S.cur) return;
        if (m.clear) { dropLive(); break; }
        if (!liveBlock) { liveBlock = { node: el('div', 'msg-text live'), src: '' }; }
        if (liveBlock.node.parentNode !== msgs || msgs.lastElementChild !== liveBlock.node) { closeStepGroup(); msgs.append(liveBlock.node); }
        liveBlock.src = m.text != null ? m.text : liveBlock.src + (m.d || '');
        if (!liveRaf) liveRaf = paced(() => {
          liveRaf = 0; if (!liveBlock) return;
          liveBlock.node.innerHTML = window.renderMarkdown(liveBlock.src, true);
          (liveBlock.node.lastElementChild || liveBlock.node).classList.add('caret');
          afterRender();
        });
        break;
      }
      case 'notify': {
        const r = { perm: 'Notification' in window ? Notification.permission : 'unsupported', hidden: document.hidden, standalone: matchMedia('(display-mode: standalone)').matches, ua: navigator.userAgent.slice(0, 80) };
        if (r.perm === 'granted') { navigator.serviceWorker?.ready.then((reg) => reg.showNotification(m.title, { body: m.body, tag: 'claude-test', renotify: true, icon: '/icon-192.png', badge: '/icon-192.png', vibrate: [80, 40, 80] })).then(() => { r.shown = true; wsSend({ op: 'notify-ack', r }); }).catch((e) => { r.err = String(e); wsSend({ op: 'notify-ack', r }); }); }
        else { toastLine('Notifications are off. Tap "Allow" when asked, or turn them on for this app in your phone\'s settings.'); if (r.perm === 'default') Notification.requestPermission().then((p) => wsSend({ op: 'notify-ack', r: { ...r, asked: p } })); else wsSend({ op: 'notify-ack', r }); }
        break;
      }
      case 'gone': {
        S.chats.delete(m.chat); saveChats(); store.del('ev:' + m.chat);
        if (S.cur === m.chat) showChat(null);
        if (drawerShown()) renderDrawer();
        break;
      }
      case 'full': {
        const step = msgs.querySelector(`.step[data-id="${CSS.escape(m.id)}"]`);
        if (step) { step.querySelector('.step-out pre').textContent = m.text; const more = step.querySelector('.more'); if (more) more.remove(); }
        break;
      }
      case 'terminal': renderTerminal(m.sessions); break;
      case 'run-out': case 'run-end': termMsg(m); break;
      case 'file': case 'sys': case 'lock-begin': case 'lock-state': case 'lock-reauth': case 'awake': { const h = fileWaits.get(m.rid); if (h) { fileWaits.delete(m.rid); h(m); } break; }
      case 'error': toastLine('Error: ' + m.msg); break;
    }
  }

  function setChats(list) {
    const tmp = [...S.chats.values()].filter((c) => isTmp(c.id));
    S.chats = new Map(list.map((c) => [c.id, c]));
    for (const c of tmp) S.chats.set(c.id, c);
    saveChats();
    if (drawerShown()) renderDrawer();
    updateHeader();
  }
  function saveChats() { store.set('chats', [...S.chats.values()].slice(0, 200)); }

  // ---------- chat cache ----------
  function loadCache(id) { return store.get('ev:' + id, { seq: 0, evs: [] }); }
  function saveCache() { if (S.cur) store.set('ev:' + S.cur, S.cache); }
  function cachePush(ev) {
    const evs = S.cache.evs;
    if (ev.t === 'tf') { for (let i = evs.length - 1; i >= 0; i--) if (evs[i].t === 'ts' && evs[i].b === ev.b) evs.splice(i, 1); }
    evs.push(ev);
    if (evs.length > 700) evs.splice(0, evs.length - 600);
  }
  const isTmp = (id) => typeof id === 'string' && id.startsWith('tmp-');

  function openOnServer(id) { wsSend({ op: 'open', chat: id, since: S.cache && S.cur === id ? S.cache.seq : 0 }); }

  // ---------- rendering ----------
  let blocks = new Map(), steps = new Map(), perms = new Map(), rafPending = new Set();
  let turn = [];            // text blocks of the reply being written, for its Copy button
  function resetRenderState() { blocks = new Map(); steps = new Map(); perms = new Map(); rafPending.clear(); turn = []; }
  const COPY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M5.5 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';
  // When a reply is finished, put a small Copy button under it (copies the whole reply as written).
  function endTurn() {
    const parts = turn.map((b) => b.src.trim()).filter(Boolean);
    turn = [];
    if (!parts.length) return;
    const row = el('div', 'turn-acts');
    const b = el('button', 'act', COPY_ICON + '<span>Copy</span>');
    b.setAttribute('aria-label', 'Copy this reply');
    b.onclick = () => copyWith(b.querySelector('span'), parts.join('\n\n'));
    row.append(b);
    msgs.append(row);
  }

  function showChat(id) {
    saveDraft();
    S.cur = id; store.set('cur', id);
    S.cache = id ? loadCache(id) : { seq: 0, evs: [] };
    msgs.innerHTML = '';
    resetRenderState();
    liveBlock = null;
    for (const ev of S.cache.evs) apply(ev, false);
    for (const it of S.outbox) if (it.chat === id && !msgs.querySelector(`.msg-user[data-cid="${CSS.escape(String(it.cid))}"]`)) addUser(it.text, it.cid, true);
    if (id && !isTmp(id)) openOnServer(id);
    S.atBottom = true;
    afterRender(true);
    updateHeader(); updateBusy(); updateEmpty();
    loadDraft();
    closeDrawer();
    if (wide.matches) renderDrawer();
  }

  let liveBlock = null, liveRaf = 0;
  function dropLive() { if (liveBlock) { liveBlock.node.remove(); liveBlock = null; } }
  function apply(ev, live) {
    if (ev.t === 'tf' || ev.t === 'tool' || ev.t === 'done' || ev.t === 'user' || ev.t === 'perm') dropLive();
    switch (ev.t) {
      case 'user': {
        const existing = ev.cid && msgs.querySelector(`.msg-user[data-cid="${CSS.escape(String(ev.cid))}"]`);
        if (existing) markSent(existing);
        else { const row = addUser(ev.text, ev.cid, false); if (ev.src === 'pc') row.querySelector('.msg-user-wrap').append(el('div', 'state', 'typed on PC')); }
        turn = [];
        S.thinking = false;
        break;
      }
      case 'ts': {
        const b = textBlock(ev.b);
        b.src += ev.d;
        b.streaming = true;
        scheduleText(ev.b);
        S.thinking = false;
        break;
      }
      case 'tf': {
        const b = textBlock(ev.b);
        b.src = ev.text; b.streaming = false;
        renderText(ev.b);
        break;
      }
      case 'think': S.thinking = true; break;
      case 'tool': addStep(ev); S.thinking = false; break;
      case 'tres': finishStep(ev); break;
      case 'perm': addPerm(ev, live); break;
      case 'permdone': donePerm(ev); break;
      case 'done': {
        if (live) S.sentChat = null;
        for (const [, b] of blocks) if (b.streaming) { b.streaming = false; renderText(b.key); }
        for (const s of msgs.querySelectorAll('.step.run')) { s.classList.remove('run'); s.classList.add('ok'); }
        closeStepGroup();
        endTurn();
        if (ev.err) msgs.append(el('div', 'err-line', esc(ev.err)));
        if (ev.stopped) msgs.append(el('div', 'note', 'Stopped'));
        if (live && document.hidden) notify('Claude finished', (S.chats.get(S.cur) || {}).title || '');
        S.thinking = false;
        break;
      }
      case 'err': msgs.append(el('div', 'err-line', esc(ev.msg))); break;
      case 'note': msgs.append(el('div', 'note', esc(ev.text))); break;
    }
    updateEmpty();
  }

  function addUser(text, cid, pending) {
    closeStepGroup();
    const row = el('div', 'msg-user' + (pending ? ' pending in' : ''));
    if (cid) row.dataset.cid = cid;
    const wrap = el('div', 'msg-user-wrap');
    const b = el('div', 'bubble'); b.textContent = text;
    wrap.append(b);
    if (pending) wrap.append(el('div', 'state', S.online ? 'Sending…' : 'Waiting for signal'));
    row.append(wrap);
    msgs.append(row);
    return row;
  }
  function markSent(row) { row.classList.remove('pending'); const s = row.querySelector('.state'); if (s) s.remove(); }

  function textBlock(key) {
    let b = blocks.get(key);
    if (!b) {
      closeStepGroup();
      const node = el('div', 'msg-text');
      msgs.append(node);
      b = { key, node, src: '', streaming: false };
      blocks.set(key, b);
      turn.push(b);
    }
    return b;
  }
  function scheduleText(key) {
    if (rafPending.has(key)) return;
    rafPending.add(key);
    paced(() => { rafPending.delete(key); renderText(key); afterRender(); });
  }
  // Streaming text re-renders at most ~20 times a second (not every frame): on a 144 Hz screen that leaves
  // the other frames free for smooth scrolling. Returns a truthy id like requestAnimationFrame.
  let lastPaint = 0;
  function paced(fn) {
    const wait = Math.max(0, 50 - (performance.now() - lastPaint));
    return setTimeout(() => requestAnimationFrame(() => { lastPaint = performance.now(); fn(); }), wait) || 1;
  }
  const PATHLIKE = /^(~\/|\/home\/|\.{0,2}\/)?[\w@.+-]+(\/[\w@.+-]+)*\.(md|mdx|txt|py|js|mjs|ts|tsx|json|ya?ml|toml|sh|css|html|csv|ini|cfg|sql|ipynb|png|jpe?g|webp|gif|svg)$/i;
  function linkFiles(node) {
    for (const c of node.querySelectorAll('code')) {
      if (c.closest('pre')) continue;
      const t = c.textContent.trim();
      if (PATHLIKE.test(t)) { c.classList.add('file-link'); c.dataset.file = t; }
    }
  }
  function renderText(key) {
    const b = blocks.get(key);
    if (!b) return;
    b.node.innerHTML = window.renderMarkdown(b.src, b.streaming);
    if (!b.streaming) linkFiles(b.node);
    if (b.streaming) {
      const last = b.node.lastElementChild;
      (last && !last.classList.contains('code') && !last.classList.contains('table') ? last : b.node).classList.add('caret');
    }
  }

  // Tool steps: consecutive tool calls share one compact group.
  let group = null;
  const VERB = { Bash: 'Ran', Read: 'Read', Edit: 'Edited', MultiEdit: 'Edited', Write: 'Wrote', NotebookEdit: 'Edited', Glob: 'Found', Grep: 'Searched', WebFetch: 'Opened', WebSearch: 'Searched web', Agent: 'Agent', Task: 'Agent', TodoWrite: 'Plan', Skill: 'Skill', ToolSearch: 'Loaded tools', AskUserQuestion: 'Asked' };
  function closeStepGroup() { if (group) { updateGroup(group); group = null; } }
  function addStep(ev) {
    if (!group || msgs.lastElementChild !== group.node) {
      const node = el('div', 'steps');
      const sum = el('button', 'steps-sum');
      sum.hidden = true;
      sum.innerHTML = '<svg class="chev" viewBox="0 0 24 24" width="14" height="14"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg><span></span>';
      sum.onclick = () => { node.classList.toggle('open'); buzz(5); };
      node.append(sum);
      msgs.append(node);
      group = { node, sum, count: 0 };
    }
    const s = el('div', 'step run');
    s.dataset.id = ev.id;
    const verb = VERB[ev.name] || ev.name.replace(/^mcp__[^_]+__/, '');
    s.innerHTML = `<button class="step-row"><span class="step-icon"></span><span class="step-verb">${esc(verb)}</span><span class="step-arg">${esc(ev.sum || '')}</span></button><div class="step-out"><pre></pre></div>`;
    s.querySelector('.step-row').onclick = () => toggleStep(s);
    const out = s.querySelector('.step-out');
    if (ev.diff && (ev.diff.old || ev.diff.new)) {
      const d = el('div', 'diff');
      if (ev.diff.old) d.append(el('div', 'del', esc(ev.diff.old)));
      if (ev.diff.new) d.append(el('div', 'add', esc(ev.diff.new)));
      out.prepend(d);
    }
    if (ev.file) {
      const b = el('button', 'open-file', 'Open file');
      b.onclick = (e) => { e.stopPropagation(); openFile(ev.file); };
      out.append(b);
    }
    group.node.append(s);
    group.count++;
    steps.set(ev.id, { node: s, n: 0 });
    updateGroup(group);
  }
  function updateGroup(g) {
    // Three or more steps fold into one line (the newest stays visible); tap it to see them all.
    g.sum.hidden = g.count < 3;
    g.sum.querySelector('span').textContent = `${g.count} steps`;
    g.node.classList.toggle('collapsed', g.count >= 3);
  }
  function finishStep(ev) {
    const s = steps.get(ev.id);
    if (!s) return;
    s.node.classList.remove('run');
    s.node.classList.add(ev.ok ? 'ok' : 'bad');
    s.node.querySelector('.step-icon').textContent = ev.ok ? '✓' : '✕';
    s.node.querySelector('.step-out pre').textContent = ev.prev || '(no output)';
    if (ev.n > (ev.prev || '').length) {
      const more = el('button', 'more', `Show full output (${fmtSize(ev.n)})`);
      more.onclick = (e) => { e.stopPropagation(); more.textContent = 'Loading…'; wsSend({ op: 'full', chat: S.cur, id: ev.id }) || (more.textContent = 'Needs connection'); };
      s.node.querySelector('.step-out').append(more);
    }
  }
  function toggleStep(node) { node.classList.toggle('open'); buzz(4); }
  const fmtBytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
  const fmtSize = (n) => n > 1024 ? (n / 1024).toFixed(n > 10240 ? 0 : 1) + ' KB' : n + ' chars';

  // Approvals
  const ASK = { Bash: 'Run this command?', Edit: 'Edit this file?', MultiEdit: 'Edit this file?', Write: 'Write this file?', WebFetch: 'Open this page?', WebSearch: 'Search the web?', NotebookEdit: 'Edit this notebook?' };
  function addPerm(ev, live) {
    closeStepGroup();
    const card = el('div', 'perm');
    card.dataset.id = ev.id;
    if (ev.opts) {
      card.innerHTML = `<div class="perm-title">${esc(ev.title || ev.tool)}</div>` + (ev.sum ? `<div class="perm-cmd">${esc(ev.sum)}</div>` : '');
      ev.opts.forEach((o) => {
        const no = /^no\b/i.test(o.l);
        const b = el('button', 'q-opt' + (no ? ' q-no' : o.n === '1' ? ' q-yes' : ''), esc(o.l));
        b.onclick = () => {
          buzz(12);
          if (!wsSend({ op: 'perm', chat: S.cur, id: ev.id, n: o.n, no })) return toastLine('No connection. Tap again when back online.');
          card.style.opacity = .5; card.style.pointerEvents = 'none';
        };
        card.append(b);
      });
    } else if (ev.questions) {
      const step = ev.tabs && ev.tabs.length > 1 ? ` · ${Math.min(ev.tabs.filter((t) => t.done).length + 1, ev.tabs.length)} of ${ev.tabs.length}` : '';
      card.innerHTML = `<div class="perm-title">Claude is asking${step}</div>`;
      const answers = {};
      ev.questions.forEach((q) => {
        card.append(el('div', 'q-text', esc(q.q)));
        const chosen = new Set(q.opts.filter((o) => o.checked).map((o) => o.l));
        q.opts.forEach((o) => {
          const b = el('button', 'q-opt', esc(o.l) + (o.d ? `<small>${esc(o.d)}</small>` : ''));
          b.onclick = () => {
            buzz();
            if (q.multi) { chosen.has(o.l) ? chosen.delete(o.l) : chosen.add(o.l); b.classList.toggle('sel'); }
            else { chosen.clear(); chosen.add(o.l); card.querySelectorAll('.q-opt').forEach((x) => x.parentNode === card && x.dataset.q === q.q && x.classList.remove('sel')); b.classList.add('sel'); }
            answers[q.q] = [...chosen].join(', ');
            if (!q.multi && ev.questions.length === 1) submit();
          };
          b.dataset.q = q.q;
          if (chosen.has(o.l)) b.classList.add('sel');
          card.append(b);
        });
        if (q.multi) answers[q.q] = [...chosen].join(', ');
        if (q.other || !ev.pcask) {
          // Own answer, like "Type something" on the PC.
          const row = el('div', 'q-other');
          const inp = el('input'); inp.type = 'text'; inp.placeholder = 'Or type your own answer'; inp.setAttribute('aria-label', 'Your own answer to: ' + q.q);
          const go = el('button', 'primary', 'Send');
          const sendOwn = () => { const t = inp.value.trim(); if (!t) return inp.focus(); buzz(); answers[q.q] = q.multi ? [...chosen, t].join(', ') : t; submit(); };
          go.onclick = sendOwn; inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); sendOwn(); } };
          row.append(inp, go); card.append(row);
        }
      });
      const submit = () => { if (wsSend({ op: 'perm', chat: S.cur, id: ev.id, answers })) card.style.opacity = .5; };
      const btns = el('div', 'perm-btns');
      const skip = el('button', 'btn-deny', 'Skip');
      skip.onclick = () => { buzz(); wsSend({ op: 'perm', chat: S.cur, id: ev.id }); };
      btns.append(skip);
      if (ev.questions.length > 1 || ev.questions.some((q) => q.multi)) { const ok = el('button', 'primary', ev.pcask && ev.tabs && ev.tabs.length > 1 ? 'Next' : 'Send'); ok.onclick = () => { buzz(); submit(); }; btns.append(ok); }
      card.append(btns);
    } else {
      card.innerHTML = `<div class="perm-title">${esc(ASK[ev.tool] || 'Allow ' + ev.tool + '?')}</div><div class="perm-cmd">${esc(ev.sum || '')}</div>`;
      if (ev.detail) {
        if (ev.detail.note) card.append(el('p', 'perm-note', esc(ev.detail.note)));
        if (ev.detail.old != null || ev.detail.new != null) {
          const d = el('div', 'diff');
          if (ev.detail.old) d.append(el('div', 'del', esc(ev.detail.old)));
          if (ev.detail.new) d.append(el('div', 'add', esc(ev.detail.new)));
          card.append(d);
        }
      }
      const btns = el('div', 'perm-btns');
      const deny = el('button', 'btn-deny', 'Deny');
      const allow = el('button', 'primary', 'Allow');
      const answer = (allowIt, always) => {
        buzz(12);
        if (!wsSend({ op: 'perm', chat: S.cur, id: ev.id, allow: allowIt, always })) return toastLine('No connection. Tap again when back online.');
        card.style.opacity = .5; card.style.pointerEvents = 'none';
      };
      deny.onclick = () => answer(false);
      allow.onclick = () => answer(true);
      btns.append(deny, allow);
      card.append(btns);
      if (ev.always) { const a = el('button', 'perm-always', 'Always allow this in this chat'); a.onclick = () => answer(true, true); card.append(a); }
    }
    if (live) card.classList.add('in');
    msgs.append(card);
    perms.set(ev.id, { node: card, ev });
    if (live) { buzz([15, 60, 15]); if (document.hidden) notify('Claude needs your approval', ev.sum || ev.tool); }
  }
  function donePerm(ev) {
    const p = perms.get(ev.id);
    if (!p) return;
    const ok = ev.ok;
    // Allowed: the step row already shows what ran, so just remove the card.
    if (ok && !p.ev.questions) { p.node.remove(); perms.delete(ev.id); return; }
    if (p.ev.opts) { p.node.replaceWith(el('div', 'perm-done', `<span class="tag bad">Denied</span><code>${esc(p.ev.title || '')}</code>`)); perms.delete(ev.id); return; }
    const label = ev.why === 'always' ? 'Always allowed' : ok ? (p.ev.questions ? 'Answered' : 'Allowed') : ev.why === 'denied' ? 'Denied' : ev.why === 'dismissed' ? 'Skipped' : 'Cancelled';
    const line = el('div', 'perm-done', `<span class="tag ${ok ? 'ok' : 'bad'}">${label}</span><code>${esc(p.ev.questions ? (ev.why || '') : (p.ev.sum || p.ev.tool))}</code>`);
    p.node.replaceWith(line);
    perms.delete(ev.id);
  }

  function toastLine(text) { msgs.append(el('div', 'note', esc(text))); afterRender(); }

  function pickProject(p) {
    S.project = p; store.set('project', p); buzz(4);
    if (drawerShown()) { renderDrawer(); $('termList').innerHTML = ''; }
    if (!S.cur) { updateEmpty(); updateHeader(); loadDraft(); }
  }
  function updateEmpty() {
    const empty = !msgs.children.length;
    $('empty').hidden = !empty;
    if (!empty) return;
    const c = S.cur && S.chats.get(S.cur);
    const box = $('emptyProjects');
    box.innerHTML = '';
    // A new chat: choose the project right here. An existing empty chat already has one.
    const choose = !c && S.projects.length > 1;
    box.hidden = !choose;
    $('emptyHint').textContent = c ? 'in ' + c.project : choose ? 'Pick a project, then send a message' : S.project ? 'in ' + S.project : '';
    if (!choose) return;
    for (const p of S.projects) {
      const b = el('button', 'chip' + (p === S.project ? ' on' : ''), esc(p));
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', p === S.project);
      b.onclick = () => pickProject(p);
      box.append(b);
    }
  }

  // ---------- scroll ----------
  function afterRender(force) {
    if (force || S.atBottom) log.scrollTop = log.scrollHeight;
    jump.hidden = S.atBottom;
  }
  // Hide the keyboard like other chat apps: drag the chat down, or tap an empty part of it.
  {
    let ky = null;
    log.addEventListener('touchstart', (e) => { ky = document.activeElement === input ? e.touches[0].clientY : null; }, { passive: true });
    log.addEventListener('touchmove', (e) => { if (ky != null && e.touches[0].clientY - ky > 24) { input.blur(); ky = null; } }, { passive: true });
    log.addEventListener('click', (e) => {
      if (document.activeElement !== input) return;
      if (e.target.closest('a,button,code,pre,.step-row,.perm,.q-opt,input,textarea')) return;
      if (String(getSelection()).length) return;
      input.blur();
    });
  }
  // Only the user's own finger or wheel can unpin the chat from the latest message.
  // Layout changes (app coming back, keyboard, page reload) used to unpin it and leave you at the top.
  let userScrollAt = 0;
  const userScroll = () => { userScrollAt = Date.now(); };
  for (const t of ['touchstart', 'touchmove', 'wheel']) log.addEventListener(t, userScroll, { passive: true });
  log.addEventListener('scroll', () => {
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const byUser = Date.now() - userScrollAt < 1500;
    if (atBottom !== S.atBottom && (atBottom || byUser)) { S.atBottom = atBottom; jump.hidden = atBottom; }
    else if (!atBottom && S.atBottom && !byUser) log.scrollTop = log.scrollHeight;
    $('top').classList.toggle('scrolled', log.scrollTop > 4);
  }, { passive: true });
  function pinBottom() { S.atBottom = true; jump.hidden = true; log.scrollTop = log.scrollHeight; }
  // Down button: straight to the latest message, no slow slide.
  jump.onclick = () => { userScrollAt = 0; pinBottom(); buzz(4); };
  // Coming back to the app: if you were at the latest message, stay there (again after layout settles).
  function repin() { if (!S.atBottom) return; pinBottom(); requestAnimationFrame(() => requestAnimationFrame(pinBottom)); setTimeout(() => S.atBottom && pinBottom(), 350); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) repin(); });
  addEventListener('pageshow', repin);
  // Any size change of the chat (text drawn late, view resized) keeps it pinned.
  new ResizeObserver(() => { if (S.atBottom) log.scrollTop = log.scrollHeight; }).observe(msgs);
  new ResizeObserver(() => { if (S.atBottom) log.scrollTop = log.scrollHeight; }).observe(log);
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--composer-h', $('composer').offsetHeight + 'px');
    if (S.atBottom) log.scrollTop = log.scrollHeight;
  }).observe($('composer'));
  // Keyboard: Android Chrome shrinks the page itself. Safari on iPhone and iPad does not: it slides the
  // whole page up instead, hiding the header. So size the app to the part of the screen that is actually
  // visible, and undo Safari's slide. "kb" drops the home-bar gap while the keyboard covers it.
  const vv = window.visualViewport;
  function fit() {
    if (!vv) return;
    root.style.setProperty('--app-h', Math.round(vv.height) + 'px');
    root.classList.toggle('kb', innerHeight - vv.height > 120 || (document.activeElement === input && coarse && screen.height - vv.height > 260));
    if (ios && (scrollY || vv.offsetTop)) scrollTo(0, 0);
    if (S.atBottom) log.scrollTop = log.scrollHeight;
  }
  if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); addEventListener('orientationchange', () => setTimeout(fit, 250)); fit(); }
  input.addEventListener('blur', () => setTimeout(fit, 60));

  msgs.addEventListener('click', (e) => {
    const f = e.target.closest('code.file-link');
    if (f) { buzz(4); openFile(f.dataset.file); return; }
    const c = e.target.closest('[data-copy]');
    if (!c) return;
    copyWith(c, c.closest('.code').querySelector('code').textContent);
  });
  // Copy, and always say what happened. The clipboard API can refuse (no HTTPS, app not focused,
  // older Safari), so fall back to the old select-and-copy way before giving up.
  async function copy(text) {
    try { if (navigator.clipboard && isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch {}
    const t = el('textarea'); t.value = text; t.setAttribute('readonly', '');
    Object.assign(t.style, { position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', opacity: '0', fontSize: '16px' });
    document.body.append(t);
    const had = document.activeElement;
    t.focus({ preventScroll: true }); t.select(); t.setSelectionRange(0, text.length);
    let ok = false; try { ok = document.execCommand('copy'); } catch {}
    t.remove(); if (had && had.focus && had !== document.body) had.focus({ preventScroll: true });
    return ok;
  }
  function copyWith(label, text) {
    const was = label.dataset.was || (label.dataset.was = label.textContent);
    return copy(text).then((ok) => {
      label.textContent = ok ? 'Copied' : 'Couldn\'t copy';
      if (ok) buzz(); else toastLine('Copy was blocked. Press and hold the text to select it instead.');
      clearTimeout(label._t); label._t = setTimeout(() => (label.textContent = was), 1400);
    });
  }

  // ---------- header / busy / banner ----------
  function updateHeader() {
    const c = S.cur && S.chats.get(S.cur);
    $('title').textContent = c ? c.title : 'New chat';
    const proj = c ? c.project : S.project;
    const conn = S.online || Date.now() < S.resumeUntil ? proj : S.everOnline || S.tries > 2 ? (navigator.onLine === false ? 'Offline' : 'Reconnecting…') : 'Connecting…';
    const sw = S.online && c && c.pc && c.live ? [MODE_LABEL[c.mode], c.model, c.effort].filter(Boolean).join(' · ') : '';
    $('subText').textContent = sw ? conn + ' · ' + sw : conn;
    // Terminal look: a status line under the message box, like the one in a terminal.
    const state = S.online || Date.now() < S.resumeUntil ? 'online' : navigator.onLine === false ? 'offline' : 'reconnecting';
    $('statusText').textContent = [proj ? '~/' + proj : '', sw, state].filter(Boolean).join('  ·  ');
    $('statusline').dataset.state = state;
    $('titleWrap').classList.toggle('tappable', !!(c && c.pc));
  }
  // ---------- PC switches (like Shift+Tab, /model, /effort on the PC) ----------
  const MODE_LABEL = { manual: 'Manual', edits: 'Accept edits', plan: 'Plan', auto: 'Auto', bypass: 'Bypass' };
  function seg(title, opts, cur, onPick) {
    const wrap = el('div', 'sw-row');
    wrap.append(el('div', 'sw-title', esc(title)));
    const row = el('div', 'seg');
    for (const [val, label] of opts) {
      const b = el('button', val === cur ? 'on' : '', esc(label));
      b.onclick = () => { buzz(6); for (const x of row.children) x.classList.remove('on'); b.classList.add('on'); onPick(val); };
      row.append(b);
    }
    wrap.append(row);
    return wrap;
  }
  function openSwitches() {
    const c = S.cur && S.chats.get(S.cur);
    if (!c || !c.pc) return;
    sheet.innerHTML = `<div class="grab"></div><div class="sheet-title">Claude on the PC · ${esc(c.project)}</div>`;
    sheet.append(seg('Mode', [['manual', 'Manual'], ['edits', 'Edits'], ['plan', 'Plan'], ['auto', 'Auto']], c.mode,
      (v) => wsSend({ op: 'pcmode', chat: c.id, mode: v }) || toastLine('Needs connection')));
    sheet.append(seg('Effort', [['low', 'Low'], ['medium', 'Med'], ['high', 'High'], ['xhigh', 'XHigh'], ['max', 'Max']], c.effort,
      (v) => wsSend({ op: 'pcslash', chat: c.id, cmd: 'effort', val: v }) || toastLine('Needs connection')));
    sheet.append(seg('Model', [['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']], c.model,
      (v) => wsSend({ op: 'pcslash', chat: c.id, cmd: 'model', val: v }) || toastLine('Needs connection')));
    sheet.append(el('div', 'sw-note', 'Effort and model change only while Claude is idle.'));
    const done = el('button', '', 'Done'); done.onclick = closeSheet; done.style.textAlign = 'center'; done.style.marginTop = '6px';
    sheet.append(done);
    sheet.hidden = false; requestAnimationFrame(() => sheet.classList.add('show'));
  }
  $('titleWrap').addEventListener('click', () => { const c = S.cur && S.chats.get(S.cur); if (c && c.pc) { buzz(4); openSwitches(); } });

  let tick = null;
  function updateBusy() {
    const c = S.cur && S.chats.get(S.cur);
    // Show "Working" the moment a message is sent; the PC reports it a second later.
    const justSent = c && S.sentChat === c.id && Date.now() - S.sentAt < 8000;
    if (c && c.busy && S.sentChat === c.id) S.sentChat = null;
    const busy = !!(c && (c.busy || justSent));
    const waiting = perms.size > 0;
    if (busy && !S.busySince) S.busySince = Date.now();
    if (!busy) S.busySince = 0;
    working.hidden = !busy || waiting;
    clearInterval(tick);
    if (busy && !waiting) {
      const upd = () => {
        const s = Math.round((Date.now() - S.busySince) / 1000);
        workingText.textContent = (S.thinking ? 'Thinking' : 'Working') + (s >= 3 ? ` · ${s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'}` : '');
      };
      upd(); tick = setInterval(upd, 1000);
    }
    updateComposer();
    afterRender();
  }

  function updateBanner() {
    const waitingMsgs = S.outbox.length;
    if (S.online || Date.now() < S.resumeUntil || !S.everOnline && !waitingMsgs && S.tries < 3) { banner.hidden = true; return; }
    banner.hidden = false;
    const base = navigator.onLine === false ? 'No signal.' : 'Can\'t reach your PC. Retrying…';
    banner.textContent = waitingMsgs ? `${base} ${waitingMsgs} message${waitingMsgs > 1 ? 's' : ''} will send when you're back.` : base + ' Claude keeps working on the PC.';
  }

  // ---------- composer ----------
  function updateComposer() {
    const has = input.value.trim().length > 0 || S.atts.some((a) => a.path);
    const c = S.cur && S.chats.get(S.cur);
    const busy = !!(c && c.busy);
    sendBtn.disabled = !has;
    sendBtn.hidden = busy && !has;
    stopBtn.hidden = !(busy && !has);
  }
  function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.38) + 'px'; }
  input.addEventListener('input', () => { grow(); updateComposer(); clearTimeout(input._t); input._t = setTimeout(saveDraft, 400); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.isComposing) { e.preventDefault(); doSend(); }
  });
  // Phone: close the keyboard after sending, like other chat apps. Desktop: keep typing.
  sendBtn.addEventListener('click', () => { doSend(); if (coarse) input.blur(); else input.focus(); });
  stopBtn.addEventListener('click', () => { buzz(12); wsSend({ op: 'stop', chat: S.cur }) || toastLine('No connection to stop it right now.'); });

  function draftKey() { return 'draft:' + (S.cur || 'new:' + S.project); }
  function saveDraft() { const v = input.value; v ? store.set(draftKey(), v) : store.del(draftKey()); }
  function loadDraft() { input.value = store.get(draftKey(), ''); grow(); updateComposer(); }

  let askedNotify = false;
  function doSend() {
    if (S.atts.some((a) => !a.path && !a.err)) return toastLine('Still uploading. Send again in a moment.');
    const files = S.atts.filter((a) => a.path);
    let text = input.value.trim();
    if (!text && !files.length) return;
    if (files.length) {
      text = (text || 'Please look at the attached file' + (files.length > 1 ? 's' : '') + '.') + '\n\n' +
        files.map((a) => `[Attached from my phone: ${a.path}]`).join('\n');
      S.atts = []; renderAtts();
    }
    buzz(10);
    if (!askedNotify && 'Notification' in window && isSecureContext && Notification.permission === 'default') { askedNotify = true; Notification.requestPermission().catch(() => {}); }
    if (!S.cur) {
      const id = 'tmp-' + rid();
      S.chats.set(id, { id, project: S.project, title: text.slice(0, 60), updated: Date.now(), busy: false });
      S.cur = id; store.set('cur', id);
      S.cache = { seq: 0, evs: [] };
      saveChats();
    }
    const cid = rid();
    S.outbox.push({ cid, chat: S.cur, project: S.chats.get(S.cur)?.project || S.project, text });
    saveOutbox();
    input.value = ''; store.del(draftKey()); grow();
    addUser(text, cid, true);
    S.atBottom = true;
    afterRender(true);
    updateHeader(); updateEmpty(); updateComposer(); updateBanner();
    flushOutbox();
    S.sentChat = S.cur; S.sentAt = Date.now(); updateBusy(); setTimeout(updateBusy, 8100);
  }
  function saveOutbox() { store.set('outbox', S.outbox); }

  // ---------- theme: Auto (follow the phone) / Light / Dark ----------
  const themeSeg = $('themeSeg');
  function showTheme() { const t = window.cmTheme ? window.cmTheme.pick() : 'auto'; for (const b of themeSeg.children) { const on = b.dataset.t === t; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); } }
  themeSeg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; store.set('theme', b.dataset.t); window.cmTheme && window.cmTheme.apply(); showTheme(); buzz(6); });
  showTheme();
  // Look: Soft (rounded, friendly) or Terminal (monospace, like Claude Code in a terminal).
  const lookSeg = $('lookSeg');
  function showLook() { const l = window.cmTheme ? window.cmTheme.look() : 'soft'; for (const b of lookSeg.children) { const on = b.dataset.l === l; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); } }
  lookSeg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; store.set('look', b.dataset.l); window.cmTheme && window.cmTheme.apply(); showLook(); buzz(6); });
  showLook();

  // ---------- attach (phone -> PC) ----------
  // Files upload to ~/Downloads/claude-mobile-uploads/<date>/ on the PC; the message gives Claude their paths.
  const atts = $('atts'), fileIn = $('fileIn'), attachBtn = $('attachBtn'), micBtn = $('micBtn');
  function renderAtts() {
    atts.hidden = !S.atts.length;
    atts.innerHTML = '';
    for (const a of S.atts) {
      const chip = el('div', 'att' + (a.err ? ' bad' : a.path ? '' : ' up'));
      chip.append(el('span', 'att-n', esc(a.name)), el('span', 'att-s', a.err ? esc(a.err) : a.path ? fmtBytes(a.size) : 'Uploading…'));
      const x = el('button', 'att-x', '×'); x.setAttribute('aria-label', 'Remove ' + a.name);
      x.onclick = () => { S.atts = S.atts.filter((b) => b !== a); renderAtts(); };
      chip.append(x); atts.append(chip);
    }
    updateComposer();
  }
  async function upload(file) {
    const a = { name: file.name || 'photo.jpg', size: file.size };
    if (file.size > 50 * 1024 * 1024) { a.err = 'Over 50 MB'; S.atts.push(a); return renderAtts(); }
    S.atts.push(a); renderAtts();
    try {
      const r = await fetch('/api/upload?name=' + encodeURIComponent(a.name), { method: 'POST', headers: hdr(), body: file });
      const j = await r.json();
      if (!r.ok) throw new Error(j.err || 'Upload failed');
      a.path = j.path; a.name = j.name; a.size = j.size;
    } catch (e) { a.err = navigator.onLine === false ? 'No signal' : (e.message || 'Upload failed'); }
    renderAtts();
  }
  attachBtn.addEventListener('click', () => { buzz(6); fileIn.click(); });
  fileIn.addEventListener('change', () => { for (const f of fileIn.files) upload(f); fileIn.value = ''; });

  // ---------- voice notes (Whisper on the PC, Urdu + English) ----------
  // v26 live: a 1s piece goes to the PC every second while recording; the PC transcribes each finished
  // sentence right away and the text appears in the box. After stop only the last few seconds remain.
  // If anything goes wrong mid-way, the whole recording is sent the old way at the end.
  let rec = null, recChunks = [], recT0 = 0, recTimer = 0, live = null;
  function livePreview(text) {
    if (!live || !text) return;
    input.value = live.base + text; grow(); updateComposer();
  }
  async function liveSend() {
    if (!live || live.sending) return;
    live.sending = true;
    const L = live;
    while (L.queue.length && !L.failed) {
      const { blob, seq } = L.queue[0];
      try {
        const r = await fetch(`/api/voice/chunk?sid=${L.sid}&seq=${seq}`, { method: 'POST', headers: hdr(), body: blob });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.err || 'chunk failed');
        L.queue.shift();
        if (live === L && rec) livePreview(j.text);
      } catch { L.failed = true; }
    }
    L.sending = false;
    const ws = L.idle; L.idle = []; ws.forEach((f) => f());
  }
  function liveDrained(L) { return L.sending ? new Promise((r) => L.idle.push(r)) : Promise.resolve(); }
  async function startRec() {
    if (!navigator.mediaDevices?.getUserMedia) return toastLine('This browser can\'t record audio.');
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { return toastLine('Microphone is blocked. Allow it for this app in your phone\'s settings.'); }
    if (!window.MediaRecorder) { stream.getTracks().forEach((t) => t.stop()); return toastLine('This browser can\'t record audio.'); }
    // Android records webm/opus. iPhone and iPad may only offer mp4/aac (not yet tested on a real iPhone).
    const type = ['audio/webm;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    rec = new MediaRecorder(stream, type ? { mimeType: type } : {});
    recChunks = [];
    const sid = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)).replace(/[^\w-]/g, '').slice(0, 36);
    live = { sid, seq: 0, queue: [], sending: false, failed: false, idle: [], base: input.value.trim() ? input.value.trim() + ' ' : '' };
    input.readOnly = true;
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      recChunks.push(e.data);
      if (live && !live.failed) { live.queue.push({ blob: e.data, seq: live.seq++ }); liveSend(); }
    };
    rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); finishRec(new Blob(recChunks, { type: rec.mimeType || 'audio/webm' })); rec = null; };
    rec.start(1000); recT0 = Date.now(); buzz([10, 40, 10]);
    micBtn.classList.add('rec'); micBtn.setAttribute('aria-label', 'Stop recording');
    const tick = () => { const s = Math.floor((Date.now() - recT0) / 1000); input.placeholder = `Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · tap the mic to stop`; if (s >= 300) stopRec(); };
    tick(); recTimer = setInterval(tick, 500);
  }
  function stopRec() { if (rec && rec.state !== 'inactive') rec.stop(); clearInterval(recTimer); micBtn.classList.remove('rec'); micBtn.setAttribute('aria-label', 'Record a voice note'); }
  async function finishRec(blob) {
    const L = live; live = null;
    input.readOnly = false;
    const base = L ? L.base : (input.value.trim() ? input.value.trim() + ' ' : '');
    if (blob.size < 1500) { input.value = base.trim(); grow(); updateComposer(); input.placeholder = 'Message Claude Code'; return; }
    micBtn.classList.add('busy'); micBtn.disabled = true; input.placeholder = 'Finishing the last words…';
    let text = null;
    if (L) {
      await liveDrained(L);
      if (!L.failed) {
        try {
          const r = await fetch(`/api/voice/end?sid=${L.sid}&seq=-1`, { method: 'POST', headers: hdr() });
          const j = await r.json();
          if (r.ok) text = j.text || '';
        } catch { /* fall back below */ }
      }
    }
    if (text === null) text = await transcribeWhole(blob);
    if (text === null) input.value = base.trim();
    else if (!text) { input.value = base.trim(); toastLine('Couldn\'t hear any words. Try again a bit closer to the mic.'); }
    else { input.value = base + text; saveDraft(); input.focus(); buzz(8); }
    grow(); updateComposer();
    micBtn.classList.remove('busy'); micBtn.disabled = false; input.placeholder = 'Message Claude Code';
  }
  async function transcribeWhole(blob) { // the old way: send the whole recording at the end
    input.placeholder = 'Turning your voice into text on the PC…';
    try {
      const r = await fetch('/api/voice', { method: 'POST', headers: hdr(), body: blob });
      const j = await r.json();
      if (!r.ok) throw new Error(j.err || 'failed');
      return j.text || '';
    } catch (e) { toastLine(navigator.onLine === false ? 'No signal. Voice note not sent.' : 'Voice note failed on the PC.'); return null; }
  }
  micBtn.addEventListener('click', () => (rec ? stopRec() : startRec()));

  // ---------- download (PC -> phone) ----------
  async function downloadFile(project, p) {
    try {
      const r = await fetch(`/api/dl?project=${encodeURIComponent(project)}&path=${encodeURIComponent(p)}`, { headers: hdr() });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.err || 'Download failed'); }
      const blob = await r.blob();
      // iPhone and iPad: the share sheet ("Save to Files", AirDrop, ...) is the reliable way to keep a file.
      if (ios && navigator.canShare) {
        const file = new File([blob], base(p), { type: blob.type || 'application/octet-stream' });
        if (navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file] }); buzz(8); return; }
          catch (e) { if (e.name === 'AbortError') return; /* otherwise fall through to a plain download */ }
        }
      }
      const url = URL.createObjectURL(blob);
      const a = el('a'); a.href = url; a.download = base(p); document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000); buzz(8);
    } catch (e) { toastLine(e.message || 'Download failed'); }
  }


  function flushOutbox() {
    if (!S.online) return;
    for (const it of S.outbox) {
      if (isTmp(it.chat)) {
        if (!it.creating) { it.creating = true; wsSend({ op: 'new', project: it.project, rid: it.chat }); }
        continue;
      }
      if (it.chat === S.cur) {
        const row = msgs.querySelector(`.msg-user[data-cid="${CSS.escape(String(it.cid))}"] .state`);
        if (row) row.textContent = 'Sending…';
      }
      wsSend({ op: 'send', chat: it.chat, text: it.text, cid: it.cid });
    }
  }

  // ---------- notifications (only while the app is in the background) ----------
  function notify(title, body) {
    document.title = '• ' + APP;
    if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
    navigator.serviceWorker?.ready.then((r) => r.showNotification(title, { body: String(body).slice(0, 120), tag: 'claude', renotify: true, icon: '/icon-192.png', badge: '/icon-192.png' })).catch(() => {});
  }


  // ---------- file viewer ----------
  const viewer = $('viewer'), vBody = $('vBody'), vTitle = $('vTitle'), vSub = $('vSub'), vAct = $('vAct');
  const fileWaits = new Map();
  let vStack = [];          // screens inside the viewer, for the back button
  let vOpen = false;
  const curProject = () => (S.cur && S.chats.get(S.cur) ? S.chats.get(S.cur).project : S.project);

  function askFile(req, op = 'file') {
    return new Promise((resolve) => {
      const r = rid();
      fileWaits.set(r, resolve);
      if (!wsSend({ op, rid: r, ...req })) { fileWaits.delete(r); resolve({ err: 'offline' }); }
      setTimeout(() => { if (fileWaits.has(r)) { fileWaits.delete(r); resolve({ err: 'timeout' }); } }, 20000);
    });
  }

  function showViewer() {
    if (vOpen) return;
    vOpen = true; viewer.hidden = false; input.blur();
    history.pushState({ v: 1 }, '');
    requestAnimationFrame(() => viewer.classList.add('show'));
  }
  function hideViewer(fromPop) {
    if (!vOpen) return;
    vOpen = false; vStack = [];
    clearInterval(sysTimer); sysTimer = 0;
    if (term && term.running) { wsSend({ op: 'run-stop' }); term.cur.end = 'Stopped (screen closed)'; term.cur.bad = true; termSave(); }
    term = null;
    viewer.classList.remove('show');
    setTimeout(() => { if (!vOpen) { viewer.hidden = true; vBody.innerHTML = ''; } }, 260);
    if (!fromPop && history.state && history.state.v) { S.skipPop = true; history.back(); }
  }
  function vBackTap() {
    buzz(4);
    vStack.pop();
    const prev = vStack.pop();
    if (!prev) return hideViewer();
    prev.kind === 'term' ? openTerm() : prev.kind === 'places' ? openPlaces() : prev.kind === 'sys' ? openSys() : prev.kind === 'dir' ? openDir(prev.path, prev.project, true) : openFile(prev.path, prev.project, true);
  }
  $('vBack').onclick = vBackTap;
  // ---------- back gesture (set 2026-11-14) ----------
  // A "guard" history entry sits on top of the app, so Android's back swipe comes to us
  // first: it closes the top layer (file viewer, bottom sheet, drawer) one at a time.
  // On the plain chat, the first back only shows a hint; a second back within 2s
  // leaves the app (Android then just puts it in the background).
  let exitArmed = false;
  function guard() { if (!(history.state && (history.state.g || history.state.v))) history.pushState({ g: 1 }, ''); }
  function hint(text) {
    let h = $('backHint');
    if (!h) { h = el('div', 'back-hint', ''); h.id = 'backHint'; document.body.append(h); }
    h.textContent = text; h.classList.add('show');
    clearTimeout(hint.t); hint.t = setTimeout(() => h.classList.remove('show'), 1800);
  }
  addEventListener('popstate', () => {
    if (S.skipPop) { S.skipPop = false; return; }
    if (vOpen) {
      if (vStack.length > 1) { history.pushState({ v: 1 }, ''); vBackTap(); } else hideViewer(true);
      return;
    }
    if (!settings.hidden) { closeSettings(); guard(); return; }
    if (!sheet.hidden) { closeSheet(); guard(); return; }
    if (drawerOpen) { closeDrawer(); guard(); return; }
    // iPhone and iPad have no "back leaves the app" gesture for installed apps: just stay.
    if (ios) { guard(); return; }
    if (exitArmed) { exitArmed = false; history.back(); return; }
    exitArmed = true; buzz(4);
    hint('Swipe back again to leave');
    setTimeout(() => { exitArmed = false; guard(); }, 2000);
  });
  guard();

  const base = (p) => String(p).split('/').filter(Boolean).pop() || p;
  const when = (t) => { const d = new Date(t); const days = Math.floor((Date.now() - t) / 864e5); return days < 1 ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : days < 7 ? d.toLocaleDateString([], { weekday: 'short' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' }); };

  async function openFile(p, project = curProject(), isBack) {
    showViewer();
    vStack.push({ kind: 'file', path: p, project });
    vTitle.textContent = base(p);
    vSub.textContent = p;
    vAct.hidden = true;
    const key = 'file:' + project + ':' + p;
    const cached = store.get(key, null);
    if (cached) renderFile(cached, true); else vBody.innerHTML = '<div class="v-msg">Opening…</div>';
    const r = await askFile({ project, path: p });
    if (vStack[vStack.length - 1]?.path !== p) return;
    if (r.dir) { vStack.pop(); return openDir(p, project); }
    const dl = () => { const b = el('button', 'v-dl', ios ? 'Save or share' : 'Download to phone'); b.onclick = () => downloadFile(project, p); vBody.append(b); };
    if (r.err) {
      if (r.err === 'offline' || r.err === 'timeout') { if (!cached) vBody.innerHTML = '<div class="v-msg">No connection. This file hasn\'t been saved on the phone yet.</div>'; return; }
      vBody.innerHTML = `<div class="v-msg">${esc(r.err)}</div>`;
      if (/not a text file|too big/i.test(r.err)) dl();
      return;
    }
    if (r.text != null && r.text.length < 300000) store.set(key, r);
    renderFile(r, false);
    dl();
  }

  function renderFile(r, isCached) {
    vSub.textContent = (r.path || '') + (r.size != null ? ' · ' + fmtBytes(r.size) : '') + (r.mtime ? ' · ' + when(r.mtime) : '');
    vBody.innerHTML = '';
    vBody.scrollTop = 0;
    if (isCached) vBody.append(el('div', 'v-note', 'Saved copy · updating…'));
    if (r.truncated) vBody.append(el('div', 'v-note', 'Large file: showing the first 600 KB.'));
    if (r.image) { const img = el('img', 'v-img'); img.src = r.image; vBody.append(img); return; }
    const text = r.text || '';
    const isMd = /\.(md|mdx|markdown)$/i.test(r.path || '');
    vAct.hidden = false;
    if (isMd) {
      let body = text, front = '';
      const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
      if (fm) { front = fm[1]; body = text.slice(fm[0].length); }
      const box = el('div', 'msg-text');
      if (front) box.append(el('div', 'front', esc(front)));
      const md = el('div'); md.innerHTML = window.renderMarkdown(body); linkFiles(md);
      box.append(...md.childNodes);
      vBody.append(box);
      vAct.textContent = 'Copy';
      delete vAct.dataset.was;
      vAct.onclick = () => copyWith(vAct, text);
    } else {
      const pre = el('pre', 'code-view' + (store.get('wrap', true) ? ' wrap' : ''));
      pre.textContent = text;
      vBody.append(pre);
      vAct.textContent = pre.classList.contains('wrap') ? 'No wrap' : 'Wrap';
      vAct.onclick = () => { const w = pre.classList.toggle('wrap'); store.set('wrap', w); vAct.textContent = w ? 'No wrap' : 'Wrap'; buzz(4); };
    }
  }

  async function openDir(p = '.', project = curProject(), isBack) {
    showViewer();
    vStack.push({ kind: 'dir', path: p, project });
    vTitle.textContent = p === '.' ? project : base(p);
    vSub.textContent = 'Files';
    // Put files from the phone into this folder.
    vAct.hidden = false; vAct.textContent = 'Upload'; delete vAct.dataset.was;
    vAct.onclick = () => { buzz(6); pickAndUpload(project, p); };
    vBody.innerHTML = '<div class="v-msg">Loading…</div>';
    const r = await askFile({ project, path: p, ls: true });
    if (vStack[vStack.length - 1]?.path !== p) return;
    if (r.err) { vBody.innerHTML = `<div class="v-msg">${esc(r.err === 'offline' ? 'No connection.' : r.err)}</div>`; return; }
    vSub.textContent = r.path;
    vBody.innerHTML = '';
    if (!r.items.length) vBody.innerHTML = '<div class="v-msg">Empty folder</div>';
    for (const it of r.items) {
      const row = el('button', 'f-row' + (it.d ? ' dir' : ''));
      row.innerHTML = `<span class="f-ico">${it.d ? '▸' : '·'}</span><span class="f-name">${esc(it.n)}</span><span class="f-meta">${it.d ? '' : fmtBytes(it.s) + ' · '}${when(it.m)}</span>`;
      const child = (p === '.' ? '' : p.replace(/\/$/, '') + '/') + it.n;
      row.onclick = () => { buzz(4); it.d ? openDir(child, project) : openFile(child, project); };
      vBody.append(row);
    }
  }
  // Phone -> a folder on the computer. Names are never overwritten: the computer adds a number.
  function pickAndUpload(project, dir) {
    const inp = el('input'); inp.type = 'file'; inp.multiple = true; inp.hidden = true;
    document.body.append(inp);
    inp.onchange = async () => {
      const files = [...inp.files]; inp.remove();
      if (!files.length) return;
      let done = 0, failed = '';
      const note = el('div', 'v-note', ''); vBody.prepend(note);
      for (const f of files) {
        note.textContent = `Uploading ${done + 1} of ${files.length}: ${f.name}`;
        if (f.size > 50 * 1024 * 1024) { failed = f.name + ' is over 50 MB'; continue; }
        try {
          const r = await fetch(`/api/upload?project=${encodeURIComponent(project)}&dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(f.name || 'file')}`, { method: 'POST', headers: hdr(), body: f });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.err || 'Upload failed');
          done++;
        } catch (e) { failed = navigator.onLine === false ? 'No signal' : (e.message || 'Upload failed'); }
      }
      buzz(8);
      // Show the folder again with the new files in it (only if the user is still looking at it).
      const top = vStack[vStack.length - 1];
      if (vOpen && top && top.kind === 'dir' && top.path === dir) { vStack.pop(); await openDir(dir, project, true); }
      if (failed && vOpen) vBody.prepend(el('div', 'v-note', esc(`${done} of ${files.length} uploaded. ${failed}.`)));
    };
    inp.click();
  }

  // ---------- terminal: run commands on the computer ----------
  // Only there when the computer's config.json turns it on, and only while the fingerprint lock is on.
  // It starts in the home folder, remembers where "cd" took you, and keeps what you ran on this phone.
  let term = null;   // { out, chips, inp, go, stop, running, rid, block, cur }
  const TERM_KEEP = 40, TERM_OUT_KEEP = 20000;
  const usesSudo = (cmd) => /(^|[;&|(]\s*)sudo(\s|$)/.test(cmd);
  function termBlock(e) {
    const b = el('div', 't-block', `<div class="t-dir">${esc(e.dir || '~')}</div><div class="t-cmd"><span>$</span> ${esc(e.cmd)}</div>`);
    if (e.out) { const pre = el('pre'); pre.textContent = e.out; b.append(pre); }
    if (e.end) b.append(el('div', 't-end' + (e.bad ? ' bad' : ''), esc(e.end)));
    return b;
  }
  function termSave() { store.set('termLog', (term ? term.log : []).slice(-TERM_KEEP)); }
  function termMsg(m) {
    if (!term || m.rid !== term.rid) return;
    const stick = term.out.scrollHeight - term.out.scrollTop - term.out.clientHeight < 60;
    const e = term.cur;
    if (m.op === 'run-out') {
      let pre = term.block.querySelector('pre');
      if (!pre) { pre = el('pre'); term.block.append(pre); }
      pre.append(m.d);
      if (e.out.length < TERM_OUT_KEEP) e.out = (e.out + m.d).slice(0, TERM_OUT_KEEP);
    } else {
      term.running = false; term.rid = null;
      const end = m.err ? m.err : m.note ? m.note : m.code === 0 ? '' : m.signal ? 'Stopped (' + m.signal + ')' : 'Exit code ' + m.code;
      const took = m.ms != null && m.ms >= 1000 ? (m.ms / 1000).toFixed(1) + 's' : '';
      e.end = [end, took].filter(Boolean).join(' · '); e.bad = !!(m.err || (m.code && m.code !== 0) || m.note);
      if (e.end) term.block.append(el('div', 't-end' + (e.bad ? ' bad' : ''), esc(e.end)));
      if (m.cwd) { store.set('termDir', m.cwd); vSub.textContent = m.cwd; }
      termSave(); termState(); termChips();
    }
    if (stick) term.out.scrollTop = term.out.scrollHeight;
  }
  function termState() {
    if (!term) return;
    term.go.hidden = term.running; term.stop.hidden = !term.running;
    term.inp.placeholder = term.running ? 'Running…' : 'Type a command';
  }
  function termStart(cmd, pw) {
    const dir = store.get('termDir', '~');
    const e = { cmd, dir, out: '', end: '', bad: false };
    term.log.push(e); term.cur = e;
    term.block = termBlock(e); term.out.append(term.block);
    term.rid = rid(); term.running = true; term.inp.value = '';
    store.set('termHist', [cmd, ...store.get('termHist', []).filter((c) => c !== cmd)].slice(0, 30));
    // The password (if any) goes to the computer for this one command and is not kept anywhere on the phone.
    if (!wsSend({ op: 'run', rid: term.rid, cmd, cwd: dir, pw: pw || undefined })) termMsg({ op: 'run-end', rid: term.rid, err: 'No connection to your computer.' });
    termState();
    term.out.scrollTop = term.out.scrollHeight;
  }
  function termRun(cmd) {
    cmd = String(cmd || '').trim();
    if (!term || term.running || !cmd) return;
    if (cmd === 'clear') { term.inp.value = ''; return termClear(); }
    if (usesSudo(cmd)) return askSudo(cmd);
    termStart(cmd);
  }
  // sudo needs the computer's password. Ask for it here, send it once, never save it.
  function askSudo(cmd) {
    term.inp.blur();
    sheet.innerHTML = '<div class="grab"></div><div class="sheet-title">This command uses sudo</div>';
    sheet.append(el('div', 'sw-note', 'Type your computer\'s password. It is sent to your computer for this one command and is not saved on the phone or written to the log.'));
    const inp = el('input', 't-pw'); inp.type = 'password'; inp.autocomplete = 'off'; inp.setAttribute('aria-label', 'Computer password'); inp.placeholder = 'Computer password';
    const run = el('button', 'primary wide', 'Run'); run.style.textAlign = 'center';
    const cancel = el('button', '', 'Cancel'); cancel.style.textAlign = 'center';
    const go = () => { const pw = inp.value; if (!pw) return inp.focus(); inp.value = ''; closeSheet(); buzz(8); termStart(cmd, pw); };
    run.onclick = go; inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    cancel.onclick = closeSheet;
    sheet.append(inp, run, cancel);
    sheet.hidden = false; requestAnimationFrame(() => { sheet.classList.add('show'); inp.focus(); });
  }
  function termClear() { if (!term || term.running) return; term.log = []; termSave(); term.out.innerHTML = ''; term.out.append(termHint()); buzz(6); }
  const termHint = () => el('div', 't-hint', 'Runs commands straight on your computer, one at a time. It starts in your home folder and remembers where cd takes you. Commands that ask questions won\'t work, and each one stops after 2 minutes.');
  // Shortcuts: jump to a project folder, then the commands you used most recently.
  function termChips() {
    if (!term) return;
    const here = store.get('termDir', '~');
    const cds = Object.values(S.dirs || {}).filter((d) => d !== here).map((d) => 'cd ' + (/\s/.test(d) ? '"' + d.replace(/^~\//, '$HOME/') + '"' : d));
    if (here !== '~') cds.unshift('cd ~');
    const hist = store.get('termHist', []).filter((c) => !/^cd(\s|$)/.test(c));
    const list = [...cds, ...(hist.length ? hist.slice(0, 8) : ['git status', 'ls -la', 'df -h .'])];
    term.chips.innerHTML = '';
    for (const c of list) {
      const b = el('button', 't-chip' + (/^cd /.test(c) ? ' cd' : ''), esc(c));
      // A folder shortcut runs at once; any other command is put in the box first so you can change it.
      b.onclick = () => { buzz(4); if (/^cd /.test(c)) termRun(c); else { term.inp.value = c; term.inp.focus(); } };
      term.chips.append(b);
    }
  }
  function openTerm() {
    showViewer();
    vStack.push({ kind: 'term', path: '__term' });
    vTitle.textContent = 'Terminal';
    vSub.textContent = store.get('termDir', '~');
    vAct.hidden = false; vAct.textContent = 'Clear'; delete vAct.dataset.was; vAct.onclick = termClear;
    vBody.innerHTML = '';
    const wrap = el('div', 'term');
    const out = el('div', 't-out');
    out.append(termHint());
    const log = store.get('termLog', []);
    for (const e of log) out.append(termBlock(e));
    const chips = el('div', 't-chips');
    const form = el('form', 't-in');
    form.innerHTML = '<span class="t-prompt">$</span>';
    const inp = el('input'); inp.type = 'text'; inp.autocapitalize = 'off'; inp.autocomplete = 'off'; inp.spellcheck = false; inp.setAttribute('autocorrect', 'off'); inp.setAttribute('aria-label', 'Command'); inp.enterKeyHint = 'go';
    const go = el('button', 'round', '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>'); go.type = 'submit'; go.setAttribute('aria-label', 'Run');
    const stop = el('button', 'round', '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor"/></svg>'); stop.type = 'button'; stop.hidden = true; stop.setAttribute('aria-label', 'Stop');
    stop.onclick = () => { buzz(12); wsSend({ op: 'run-stop' }); };
    form.append(inp, go, stop);
    form.onsubmit = (e) => { e.preventDefault(); buzz(8); termRun(inp.value); };
    wrap.append(out, chips, form);
    vBody.append(wrap);
    term = { out, chips, inp, go, stop, log, running: false, rid: null, block: null, cur: null };
    termState(); termChips();
    requestAnimationFrame(() => { out.scrollTop = out.scrollHeight; });
  }
  $('termBtn').onclick = () => { const was = drawerOpen; closeDrawer(); setTimeout(openTerm, was ? 200 : 0); };

  // ---------- this computer: CPU, memory, disk (read-only) ----------
  let sysTimer = 0, sysHist = [];
  const gb = (n) => (n / 1073741824).toFixed(n >= 107374182400 ? 0 : 1);
  const dur = (sec) => { const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
  const level = (p) => (p >= 92 ? ' bad' : p >= 80 ? ' warn' : '');
  const pctOf = (used, total) => (total ? Math.round(used / total * 100) : 0);
  function meter(label, pct, detail) {
    return `<div class="sys-card"><div class="sys-h"><span>${esc(label)}</span><b>${pct}%</b></div><div class="bar${level(pct)}"><i style="width:${pct}%"></i></div><div class="sys-sub">${esc(detail)}</div></div>`;
  }
  function spark(vals) {   // CPU over the last two minutes, newest on the right
    const W = 300, H = 56, N = 60;
    const pts = vals.map((v, i) => `${((N - vals.length + i) / (N - 1) * W).toFixed(1)},${(H - 2 - v / 100 * (H - 6)).toFixed(1)}`);
    if (pts.length < 2) return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"></svg>`;
    const x0 = ((N - vals.length) / (N - 1) * W).toFixed(1);
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polygon points="${x0},${H} ${pts.join(' ')} ${W},${H}"/><polyline points="${pts.join(' ')}"/></svg>`;
  }
  function renderSys(r) {
    if (r.err) { if (!vBody.querySelector('.sys')) vBody.innerHTML = `<div class="v-msg">${esc(r.err === 'offline' || r.err === 'timeout' ? 'No connection to your computer.' : r.err)}</div>`; return; }
    sysHist.push(r.cpu); if (sysHist.length > 60) sysHist.shift();
    vSub.textContent = `${r.host} · ${r.os} · up ${dur(r.uptime)}`;
    const mem = pctOf(r.mem.used, r.mem.total);
    let h = `<div class="sys-card"><div class="sys-h"><span>CPU</span><b class="${level(r.cpu).trim()}">${r.cpu}%</b></div>${spark(sysHist)}<div class="sys-sub">${r.cores} cores${r.load != null ? ' · load ' + r.load : ''}${r.temp != null ? ' · ' + r.temp + '°C' : ''}</div></div>`;
    h += meter('Memory', mem, `${gb(r.mem.used)} of ${gb(r.mem.total)} GB used`);
    for (const d of r.disks) h += meter(r.disks.length > 1 ? 'Disk · ' + d.label : 'Disk', pctOf(d.used, d.total), `${gb(d.total - d.used)} GB free of ${gb(d.total)} GB`);
    if (r.battery) h += `<div class="sys-card"><div class="sys-h"><span>Battery</span><b>${r.battery.pct}%</b></div><div class="bar${r.battery.pct <= 15 && r.battery.state !== 'charging' ? ' bad' : ''}"><i style="width:${r.battery.pct}%"></i></div><div class="sys-sub">${esc(r.battery.state)}</div></div>`;
    h += `<div class="sys-card"><div class="sys-h"><span>Claude Code</span></div><div class="sys-sub">${r.claude.working ? r.claude.working + ' working' : 'Nothing running'}${r.claude.waiting ? ' · ' + r.claude.waiting + ' waiting for you' : ''}</div></div>`;
    if (r.procs.length) h += `<div class="sys-card"><div class="sys-h"><span>Busiest right now</span><span class="sys-cols">CPU · Memory</span></div>` + r.procs.map((p) => `<div class="proc"><span>${esc(p.name)}</span><b>${p.cpu.toFixed(0)}% · ${p.mem.toFixed(0)}%</b></div>`).join('') + `</div>`;
    const top = vBody.scrollTop;
    vBody.innerHTML = `<div class="sys">${h}</div>`;
    vBody.scrollTop = top;
  }
  async function openSys() {
    showViewer();
    vStack.push({ kind: 'sys', path: '__sys' });
    vTitle.textContent = 'This computer';
    vSub.textContent = '';
    vAct.hidden = true;
    sysHist = [];
    vBody.innerHTML = '<div class="v-msg">Loading…</div>';
    const tick = async () => {
      const top = vStack[vStack.length - 1];
      if (!vOpen || !top || top.kind !== 'sys') { clearInterval(sysTimer); sysTimer = 0; return; }
      if (document.hidden) return;
      const r = await askFile({}, 'sys');
      const now = vStack[vStack.length - 1];
      if (vOpen && now && now.kind === 'sys') renderSys(r);
    };
    clearInterval(sysTimer); sysTimer = setInterval(tick, 2000);
    tick();
  }
  $('sysBtn').onclick = () => { const was = drawerOpen; closeDrawer(); setTimeout(openSys, was ? 200 : 0); };

  // Files starts with every place the phone may reach: your project folders, then any extra folders.
  const FOLDER_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 6.5A1.5 1.5 0 0 1 5.5 5H10l2 2h6.5A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/></svg>';
  function openPlaces() {
    // One project and nothing else: no need for a list, go straight in.
    if (S.projects.length + S.folders.length <= 1) return openDir('.', S.projects[0] || curProject());
    showViewer();
    vStack.push({ kind: 'places', path: '__places' });
    vTitle.textContent = 'Files';
    vSub.textContent = 'On your computer';
    vAct.hidden = true;
    vBody.innerHTML = '';
    const section = (title, names, note) => {
      if (!names.length) return;
      vBody.append(el('div', 'f-head', esc(title)));
      for (const n of names) {
        const row = el('button', 'f-row dir', `<span class="f-ico">${FOLDER_ICON}</span><span class="f-name">${esc(n)}</span><span class="f-meta">${n === curProject() ? 'this chat' : ''}</span>`);
        row.onclick = () => { buzz(4); openDir('.', n); };
        vBody.append(row);
      }
      if (note) vBody.append(el('div', 'f-foot', esc(note)));
    };
    section('Projects', S.projects);
    section('Folders', S.folders, 'For moving files only. Claude does not work in these.');
  }
  $('filesBtn').onclick = () => { const was = drawerOpen; closeDrawer(); setTimeout(openPlaces, was ? 200 : 0); };

  // ---------- drawer ----------
  let drawerOpen = false;
  const drawerShown = () => drawerOpen || wide.matches;
  const drawer = $('drawer'), scrim = $('scrim');
  wide.addEventListener('change', () => { closeDrawer(); if (wide.matches) renderDrawer(); });
  function openDrawer() {
    if (wide.matches) return;
    drawerOpen = true; renderDrawer(); $('termList').innerHTML = '';
    scrim.hidden = false; requestAnimationFrame(() => { scrim.classList.add('show'); drawer.classList.add('show'); });
    drawer.setAttribute('aria-hidden', 'false'); input.blur(); buzz(4);
  }
  function closeDrawer() {
    if (!drawerOpen) return;
    drawerOpen = false; drawer.classList.remove('show'); scrim.classList.remove('show');
    drawer.setAttribute('aria-hidden', 'true');
    setTimeout(() => { if (!drawerOpen && settings.hidden) scrim.hidden = true; }, 260);
  }
  $('menuBtn').onclick = openDrawer;
  scrim.onclick = () => { closeDrawer(); closeSettings(); };
  $('newBtn').onclick = () => { buzz(); showChat(null); input.focus(); };
  $('drawerNew').onclick = () => { showChat(null); setTimeout(() => input.focus(), 280); };

  function renderDrawer() {
    const seg = $('projects');
    seg.innerHTML = '';
    for (const p of S.projects) {
      const b = el('button', p === S.project ? 'on' : '', esc(p));
      b.onclick = () => pickProject(p);
      seg.append(b);
    }
    const list = $('chatList');
    list.innerHTML = '';
    const pcs = [...S.chats.values()].filter((c) => c.pc);
    if (pcs.length) list.append(el('div', 'day', 'Continue Claude Code chat from your computer'));
    for (const c of pcs) {
      const row = el('button', 'chat-row pc-row' + (c.id === S.cur ? ' cur' : ''));
      row.innerHTML = `<span class="live ${c.live ? 'on' : ''}"></span><span class="t">${esc(c.project)}</span>` + (c.waiting ? '<span class="badge">Needs you</span>' : c.busy ? '<span class="busy"></span>' : `<span class="pc-state">${c.live ? 'open' : 'starts when you send'}</span>`);
      row.onclick = () => { buzz(4); S.project = c.project; store.set('project', c.project); showChat(c.id); };
      list.append(row);
    }
    const items = [...S.chats.values()].filter((c) => !c.pc && c.project === S.project).sort((a, b) => b.updated - a.updated);
    // "Phone-only" only means something next to chats that are also open on the computer.
    if (items.length && pcs.length) list.append(el('div', 'day', 'Phone-only chats · ' + S.project));
    $('drawerNewText').textContent = pcs.length ? 'Phone-only chat' : 'New chat';
    let lastDay = '';
    for (const c of items) {
      const d = dayLabel(c.updated);
      if (d !== lastDay) { list.append(el('div', 'day', d)); lastDay = d; }
      const row = el('button', 'chat-row' + (c.id === S.cur ? ' cur' : ''));
      row.innerHTML = `<span class="t">${esc(c.title || 'Chat')}</span>` + (c.waiting ? '<span class="badge">Needs you</span>' : c.busy ? '<span class="busy"></span>' : '');
      row.onclick = () => { buzz(4); showChat(c.id); };
      longPress(row, () => openSheet(c));
      list.append(row);
    }
  }
  function dayLabel(t) {
    const d = new Date(t), now = new Date();
    const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  if (false) $('importBtn').onclick = () => {
    if (!wsSend({ op: 'terminal', project: S.project })) { $('termList').innerHTML = '<div class="day">Needs connection</div>'; return; }
    $('termList').innerHTML = '<div class="day">Loading…</div>';
  };
  function renderTerminal(sessions) {
    const box = $('termList');
    box.innerHTML = '';
    if (!sessions.length) { box.append(el('div', 'day', 'No other PC chats here')); return; }
    for (const s of sessions) {
      const row = el('button', 'chat-row', `<span class="t">${esc(s.title)}</span>`);
      row.onclick = () => { buzz(); row.style.opacity = .5; wsSend({ op: 'import', project: S.project, sessionId: s.sessionId, rid: rid() }); };
      box.append(row);
    }
  }

  function longPress(node, fn) {
    let t = null, moved = false;
    node.addEventListener('touchstart', () => { moved = false; t = setTimeout(() => { if (!moved) { buzz(15); fn(); } }, 480); }, { passive: true });
    node.addEventListener('touchmove', () => { moved = true; clearTimeout(t); }, { passive: true });
    node.addEventListener('touchend', (e) => { clearTimeout(t); }, { passive: true });
    node.addEventListener('contextmenu', (e) => { e.preventDefault(); fn(); });
  }

  // Swipe from the left edge opens the chat list; swipe left closes it.
  (function swipe() {
    let x0 = null, y0 = 0, fromEdge = false;
    addEventListener('touchstart', (e) => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; fromEdge = x0 < 28; }, { passive: true });
    addEventListener('touchend', (e) => {
      if (x0 == null) return;
      const t = e.changedTouches[0], dx = t.clientX - x0, dy = Math.abs(t.clientY - y0);
      if (!drawerOpen && fromEdge && dx > 60 && dy < 50) openDrawer();
      else if (drawerOpen && dx < -60 && dy < 50) closeDrawer();
      x0 = null;
    }, { passive: true });
  })();

  // ---------- bottom sheet ----------
  const sheet = $('sheet');
  function openSheet(c) {
    sheet.innerHTML = `<div class="grab"></div><div class="sheet-title">${esc(c.title)}</div>`;
    const ren = el('button', '', 'Rename');
    const del = el('button', 'danger', 'Delete chat');
    const cancel = el('button', '', 'Cancel');
    ren.onclick = () => {
      sheet.innerHTML = '<div class="grab"></div>';
      const inp = el('input'); inp.value = c.title; inp.className = ''; Object.assign(inp.style, { width: '100%', height: '48px', borderRadius: '12px', border: '1px solid var(--line)', background: 'var(--raised2)', color: 'var(--text)', padding: '0 14px', fontSize: '16px', outline: 'none' });
      const save = el('button', 'primary wide', 'Save'); save.style.marginTop = '10px'; save.style.textAlign = 'center';
      save.onclick = () => { if (inp.value.trim()) wsSend({ op: 'rename', chat: c.id, title: inp.value.trim() }); closeSheet(); };
      sheet.append(inp, save); inp.focus(); inp.select();
    };
    del.onclick = () => {
      if (del.dataset.sure) { wsSend({ op: 'delete', chat: c.id }) || toastLine('Needs connection'); closeSheet(); return; }
      del.dataset.sure = 1; del.textContent = 'Tap again to delete'; buzz(20);
    };
    cancel.onclick = closeSheet;
    sheet.append(ren, del, cancel);
    sheet.hidden = false; requestAnimationFrame(() => sheet.classList.add('show'));
  }
  function closeSheet() { sheet.classList.remove('show'); setTimeout(() => (sheet.hidden = true), 250); }

  // ---------- settings: theme, look, fingerprint lock ----------
  const settings = $('settings');
  function openSettings() { closeDrawer(); settings.hidden = false; scrim.hidden = false; requestAnimationFrame(() => { settings.classList.add('show'); scrim.classList.add('show'); }); }
  function closeSettings() { if (settings.hidden) return; settings.classList.remove('show'); scrim.classList.remove('show'); setTimeout(() => { settings.hidden = true; if (!drawerOpen) scrim.hidden = true; }, 250); }
  $('settingsBtn').onclick = () => { buzz(4); const was = drawerOpen; closeDrawer(); setTimeout(openSettings, was && !wide.matches ? 180 : 0); };
  $('settingsDone').onclick = closeSettings;

  // ---------- keep the computer awake ----------
  // A sleeping computer can't be reached at all, so this switch stops it sleeping (while plugged in).
  const awakeSeg = $('awakeSeg');
  function showAwake(a) {
    S.awake = a || S.awake;
    const st = S.awake;
    $('awakeRow').hidden = !(st && st.supported);
    if (!st || !st.supported) return;
    for (const b of awakeSeg.children) { const on = (b.dataset.v === 'on') === !!st.on; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); }
    $('awakeNote').textContent = !st.on ? 'Off: if the computer sleeps' + (st.lid ? ' or its lid is closed' : '') + ', the phone can\'t reach it until someone wakes it.'
      : st.active ? 'Your computer stays awake while it is plugged in' + (st.lid ? ', even with the lid closed.' : '.')
      : st.onBattery ? 'On, but paused: the computer is on battery, so it is allowed to sleep.'
      : 'On, but the computer refused the request. It may still sleep.';
  }
  awakeSeg.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const want = b.dataset.v === 'on';
    if (S.awake && want === !!S.awake.on) return;
    buzz(6);
    const r = await askFile({ on: want }, 'awake');
    if (r.err) return toastLine('Needs connection');
    showAwake(r);
  });

  // ---------- fingerprint lock ----------
  // A passkey kept by this phone. Turning the lock on makes one; after that the phone's fingerprint,
  // face or screen lock must approve each time the app is opened, and the computer checks the proof.
  const canLock = !!(window.PublicKeyCredential && isSecureContext);
  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = (t) => Uint8Array.from(atob(String(t).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  let lockMsg = null, lockBusy = false, lockPromptAt = 0;
  function showLock(m) {
    lockMsg = m;
    $('lock').hidden = false; input.blur();
    $('lockErr').textContent = m.err ? m.err + '. Tap to try again.' : '';
    // Ask straight away when the app is opened; after a miss, wait for a tap so it doesn't nag.
    if (!m.err && !document.hidden && Date.now() - lockPromptAt > 20000) unlock();
  }
  function hideLock() { $('lock').hidden = true; lockMsg = null; }
  async function unlock() {
    if (!lockMsg || lockBusy) return;
    if (!canLock) { $('lockErr').textContent = 'This browser can\'t check a fingerprint at this address. Open the app with its https address.'; return; }
    lockBusy = true; lockPromptAt = Date.now(); $('lockErr').textContent = '';
    const m = lockMsg;
    try {
      const cred = await navigator.credentials.get({ publicKey: {
        challenge: unb64u(m.challenge), rpId: location.hostname, userVerification: 'required', timeout: 60000,
        allowCredentials: m.ids.map((id) => ({ type: 'public-key', id: unb64u(id) })),
      } });
      const r = cred.response;
      if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ op: 'unlock', id: cred.id, authData: b64u(r.authenticatorData), clientData: b64u(r.clientDataJSON), sig: b64u(r.signature) }));
      else $('lockErr').textContent = 'Lost the connection. Tap to try again.';
    } catch (e) {
      $('lockErr').textContent = e.name === 'NotAllowedError' ? 'Not unlocked. Tap to try again.' : 'Couldn\'t check: ' + (e.message || e.name);
    }
    lockBusy = false;
  }
  $('unlockBtn').onclick = () => { buzz(6); if (!lockMsg) { $('lockErr').textContent = navigator.onLine === false ? 'No signal. The app unlocks once it can reach your computer.' : 'Still connecting to your computer…'; return; } unlock(); };
  // The lock was on last time: cover the app at once, before anything saved on the phone is shown.
  // It opens only after the computer has checked the fingerprint, so it stays shut with no signal.
  // (A phone the computer still remembers skips this, so saved chats can be read with no signal.)
  if (store.get('lockOn', false) && !store.get('sid', null)) { $('lock').hidden = false; $('lockErr').textContent = 'Connecting to your computer…'; }

  const lockSeg = $('lockSeg');
  function showLockRow() {
    $('lockRow').hidden = false;
    $('lockNote').textContent = !canLock ? 'Needs the https address to work.'
      : !S.lockOn ? 'Off: the key alone opens the app, and anyone holding this phone can use it.'
      : S.rememberDays ? `On: asked once on this phone, then again in about ${S.rememberDays} days. A leaked link alone can't get in.`
      : 'On: asks for your fingerprint, face or screen lock every time you open the app.';
    for (const b of lockSeg.children) { const on = (b.dataset.v === 'on') === !!S.lockOn; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); b.disabled = !canLock && b.dataset.v === 'on'; }
    $('lockNow').hidden = !S.lockOn;
  }
  async function lockTurnOn() {
    if (lockTurnOn.busy) return;   // a second tap while the phone is asking would make a second passkey
    lockTurnOn.busy = true;
    try { await lockTurnOnNow(); } finally { lockTurnOn.busy = false; }
  }
  async function lockTurnOnNow() {
    const b = await askFile({}, 'lock-begin');
    if (b.err) return toastLine('Needs connection');
    let cred;
    try {
      cred = await navigator.credentials.create({ publicKey: {
        rp: { name: APP, id: location.hostname },
        user: { id: unb64u(b.userId), name: APP, displayName: APP + ' on this phone' },
        challenge: unb64u(b.challenge),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        attestation: 'none', timeout: 60000,
      } });
    } catch (e) { return toastLine(e.name === 'NotAllowedError' ? 'Fingerprint lock not turned on.' : 'This phone couldn\'t make a passkey: ' + (e.message || e.name)); }
    const r = cred.response, pk = r.getPublicKey && r.getPublicKey();
    if (!pk) return toastLine('This browser can\'t share the passkey with the computer. Try updating it.');
    const res = await askFile({ id: cred.id, pk: b64u(pk), alg: r.getPublicKeyAlgorithm(), clientData: b64u(r.clientDataJSON), rpId: location.hostname }, 'lock-add');
    if (res.err) return toastLine('Couldn\'t turn the lock on: ' + (res.err === 'offline' ? 'no connection' : res.err));
    S.lockOn = !!res.on; store.set('lockOn', S.lockOn);
    // Making the passkey counted as a fingerprint check: the computer now remembers this phone.
    if (S.lockOn && S.rememberDays && S.sid) store.set('sid', S.sid);
    showLockRow(); buzz([10, 40, 10]);
  }
  lockSeg.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    const want = b.dataset.v === 'on';
    if (want === !!S.lockOn) return;
    buzz(6);
    if (want) return lockTurnOn();
    // Turning it off needs a fresh fingerprint.
    const ch = await askFile({}, 'lock-reauth');
    if (ch.err) return toastLine('Needs connection');
    let proof;
    try {
      const cred = await navigator.credentials.get({ publicKey: { challenge: unb64u(ch.challenge), rpId: location.hostname, userVerification: 'required', timeout: 60000, allowCredentials: ch.ids.map((id) => ({ type: 'public-key', id: unb64u(id) })) } });
      const r = cred.response;
      proof = { id: cred.id, authData: b64u(r.authenticatorData), clientData: b64u(r.clientDataJSON), sig: b64u(r.signature) };
    } catch (e) { showLockRow(); return toastLine('Lock left on: the fingerprint check was cancelled.'); }
    const res = await askFile({ proof }, 'lock-off');
    if (res.err) { showLockRow(); return toastLine('Lock left on: ' + (res.err === 'offline' ? 'no connection' : res.err)); }
    S.lockOn = false; store.set('lockOn', false); store.del('sid'); showLockRow();
  });
  $('lockNow').onclick = () => { buzz(8); closeDrawer(); closeSettings(); wsSend({ op: 'lock-now' }); S.sid = null; store.del('sid'); };

  // ---------- setup ----------
  function showSetup(err) {
    $('setup').hidden = false;
    $('setupErr').textContent = err || '';
    setTimeout(() => $('keyInput').focus(), 100);
  }
  function hideSetup() { $('setup').hidden = true; }
  $('keySave').onclick = () => {
    const k = $('keyInput').value.trim();
    if (!k) return;
    S.token = k; store.set('token', k);
    $('setupErr').textContent = '';
    S.tries = 0; connect();
  };
  $('keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('keySave').click(); });

  // ---------- go ----------
  if ('serviceWorker' in navigator && isSecureContext) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
    // A new version took over: reload once so the screen shows it.
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !window._reloaded) { window._reloaded = true; location.reload(); } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {}); });
  }
  if (S.cur && !S.chats.has(S.cur)) S.cur = null;
  showChat(S.cur);
  updateBanner();
  connect();

  // ---------- full screen (v30) ----------
  // The manifest asks for full screen, but an already-installed app keeps the old setting until
  // Chrome refreshes it. Fallback: on the first touch, ask for full screen ourselves (phones only).
  // Android only: iPhone has no such feature, and iPad shows a large exit button over the app.
  const wantFull = () => !ios && matchMedia('(pointer: coarse)').matches && !matchMedia('(display-mode: fullscreen)').matches
    && !document.fullscreenElement && document.documentElement.requestFullscreen;
  // A touch only counts as a user action on pointerup (pointerdown counts for a mouse only).
  addEventListener('pointerup', () => {
    if (wantFull()) document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }, { capture: true, passive: true });

  // Clock in the header while full screen hides the phone's status bar (v31).
  const isFull = () => !!document.fullscreenElement || matchMedia('(display-mode: fullscreen)').matches;
  function tickClock() {
    $('clock').textContent = isFull() ? new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
    clearTimeout(tickClock.t);
    tickClock.t = setTimeout(tickClock, 60000 - (Date.now() % 60000) + 50);  // next minute change
  }
  document.addEventListener('fullscreenchange', tickClock);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tickClock(); });
  tickClock();
})();
