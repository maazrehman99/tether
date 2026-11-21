// Check that everything Tether needs is in place. Prints one line per check.
//   npm run doctor        exit code 0 = ready, 1 = something required is missing
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8787);
const expand = (p) => path.resolve(String(p).replace(/^~(?=$|[\\/])/, os.homedir()));
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let failed = 0;
const ok = (msg) => console.log('  ok    ' + msg);
const bad = (msg, fix) => { failed++; console.log('  FAIL  ' + msg + (fix ? '\n        -> ' + fix : '')); };
const skip = (msg, fix) => console.log('  skip  ' + msg + (fix ? '\n        -> ' + fix : ''));

console.log(`\nTether check (${process.platform}${process.env.WSL_DISTRO_NAME ? ', WSL' : ''})\n`);

// Node
const major = Number(process.versions.node.split('.')[0]);
major >= 20 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} is too old`, 'Install Node 20 or newer');

// Packages
fs.existsSync(path.join(ROOT, 'node_modules', 'ws')) && fs.existsSync(path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'))
  ? ok('Packages installed') : bad('Packages are not installed', 'Run: npm install');

// Settings
let config = null;
const configFile = process.env.CM_CONFIG || path.join(ROOT, 'config.json');
try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); }
catch (e) { bad(e.code === 'ENOENT' ? 'config.json is missing' : `config.json can't be read: ${e.message}`, 'Copy config.example.json to config.json and list your project folders'); }
const projects = Object.entries((config && config.projects) || {}).map(([name, v]) => ({ name, ...(typeof v === 'string' ? { path: v } : v) }));
if (config) {
  if (!projects.length) bad('config.json has no projects', 'Add at least one: "projects": { "my-app": "~/code/my-app" }');
  for (const p of projects) {
    if (!p.path) bad(`Project "${p.name}" has no path`);
    else fs.existsSync(expand(p.path)) ? ok(`Project "${p.name}" -> ${expand(p.path)}`) : bad(`Project "${p.name}" folder not found: ${expand(p.path)}`, 'Fix the path in config.json');
  }
}

// Extra folders for the Files screen (optional)
for (const [name, dir] of Object.entries((config && config.folders) || {})) {
  fs.existsSync(expand(dir)) ? ok(`Folder "${name}" -> ${expand(dir)}`) : bad(`Folder "${name}" not found: ${expand(dir)}`, 'Fix the path in config.json, or remove it');
}

// Claude Code
const claudeBin = process.env.CLAUDE_BIN || (config && config.claudeBin ? expand(config.claudeBin) : path.join(os.homedir(), '.local/bin/claude'));
let claude = fs.existsSync(claudeBin) ? claudeBin : null;
if (!claude) { try { run('claude', ['--version']); claude = 'claude'; } catch {} }
if (claude) { try { ok('Claude Code ' + run(claude, ['--version']).split('\n')[0]); } catch { bad('Claude Code is installed but does not start', 'Run "claude" once in a terminal and sign in'); } }
else bad('Claude Code not found', 'Install it, run "claude" once and sign in. If it lives somewhere unusual, set "claudeBin" in config.json');

// Network safety
const hosts = (process.env.HOSTS || '127.0.0.1').split(',').map((h) => h.trim());
hosts.some((h) => ['0.0.0.0', '::', '[::]', '*'].includes(h))
  ? bad('HOSTS would open the app to every network', 'Use 127.0.0.1 with "tailscale serve"') : ok('Listens only on ' + hosts.join(', '));

// Tailscale
try {
  const st = JSON.parse(run('tailscale', ['status', '--json']));
  if (st.BackendState !== 'Running') bad(`Tailscale is installed but not connected (${st.BackendState})`, 'Run: tailscale up');
  else {
    ok('Tailscale is connected');
    let served = false;
    try {
      const serve = JSON.parse(run('tailscale', ['serve', 'status', '--json']));
      served = Object.values(serve.Web || {}).some((w) => Object.values(w.Handlers || {}).some((h) => new RegExp(`(127\\.0\\.0\\.1|localhost):${PORT}$`).test(h.Proxy || '')));
    } catch {}
    served ? ok(`Tailscale HTTPS forwards to port ${PORT}`) : bad(`Tailscale HTTPS is not forwarding to port ${PORT}`, `Run: tailscale serve --bg --https=443 http://127.0.0.1:${PORT}`);
  }
} catch { bad('Tailscale not found', 'Install Tailscale on this computer and on the phone, and sign in to the same account on both'); }

// Optional: join a Claude that is open in tmux
const tmuxProjects = projects.filter((p) => p.tmux);
if (!tmuxProjects.length) skip('Joining a Claude open on the computer: not set up (optional)', 'Add "tmux": "<session name>" to a project in config.json');
else { try { ok(run('tmux', ['-V']) + ` (for ${tmuxProjects.map((p) => p.name).join(', ')})`); } catch { bad('tmux not found, but config.json uses it', process.platform === 'win32' ? 'tmux needs WSL on Windows; remove "tmux" from config.json or run Tether inside WSL' : 'Install tmux, or remove "tmux" from config.json'); } }

// Optional: voice notes
const voice = (config && config.voice) || {};
if (!voice.python && !process.env.STT_PY) skip('Voice notes: not set up (optional)', 'See "Voice notes" in the README');
else {
  const py = process.env.STT_PY || expand(voice.python);
  try { run(py, ['-c', 'import faster_whisper']); ok('Voice notes: Python with faster-whisper found'); }
  catch { bad('Voice notes: this Python has no faster-whisper', `Run: ${py} -m pip install faster-whisper`); }
}

// Is the server up right now? (information only)
await new Promise((done) => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 2000 }, (res) => { res.resume(); ok(`Server is running on port ${PORT}`); done(); });
  req.on('error', () => { skip(`Server is not running on port ${PORT}`, 'Start it: npm start'); done(); });
  req.on('timeout', () => { req.destroy(); });
});

console.log(failed ? `\n${failed} thing${failed > 1 ? 's' : ''} to fix. Run "npm run doctor" again afterwards.\n` : '\nReady. Next: npm run pair\n');
process.exit(failed ? 1 : 0);
