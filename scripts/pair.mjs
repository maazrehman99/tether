// Show the QR code that connects a phone to this computer.
//   npm run pair                 find the address through Tailscale
//   npm run pair -- https://...  or give the address yourself
// The code holds the secret key: anyone who scans it can use Claude on this computer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = process.env.CM_DATA || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8787);

// Same key file the server uses; create it if the server has never run.
const tokenFile = path.join(DATA, 'token');
if (!fs.existsSync(tokenFile)) {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString('base64url'), { mode: 0o600 });
}
const token = fs.readFileSync(tokenFile, 'utf8').trim();

let config = {};
try { config = JSON.parse(fs.readFileSync(process.env.CM_CONFIG || path.join(ROOT, 'config.json'), 'utf8')); } catch {}
const ts = (...args) => JSON.parse(execFileSync('tailscale', args, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }));

// Where does the phone reach this computer? Prefer the HTTPS address that "tailscale serve" forwards to our port.
function findUrl() {
  const given = process.argv[2] || config.url;
  if (given) return { url: String(given).replace(/\/+$/, '') };
  try {
    const serve = ts('serve', 'status', '--json');
    for (const [host, web] of Object.entries(serve.Web || {})) {
      const mine = Object.values(web.Handlers || {}).some((h) => new RegExp(`(127\\.0\\.0\\.1|localhost):${PORT}$`).test(h.Proxy || ''));
      if (mine) return { url: 'https://' + host.replace(/:443$/, '') };
    }
  } catch {}
  try {
    const self = ts('status', '--json').Self || {};
    const ip = (self.TailscaleIPs || []).find((a) => a.includes('.'));
    if (ip) return { url: `http://${ip}:${PORT}`, note: `No "tailscale serve" address found for port ${PORT}, so this uses the Tailscale IP.\nThat only works if the server listens there (HOSTS=127.0.0.1,${ip}), and the app can't be installed or use the mic without HTTPS.\nBetter: tailscale serve --bg --https=443 http://127.0.0.1:${PORT}` };
  } catch {}
  return null;
}

const found = findUrl();
if (!found) {
  console.error('Could not find an address for this computer.\nIs Tailscale installed and signed in? Or pass the address: npm run pair -- https://my-computer.example.ts.net');
  process.exit(1);
}
const link = `${found.url}/#k=${encodeURIComponent(token)}`;
console.log('\nScan with your phone\'s camera (the phone must be on the same Tailscale network):\n');
qrcode.generate(link, { small: true });
console.log(`\nOr open this link on the phone:\n${link}\n`);
if (found.note) console.log(found.note + '\n');
console.log('Keep this private: the code and link hold the key to Claude on this computer.\nTo make a new key, delete data/token, restart the server and pair again.\n');
