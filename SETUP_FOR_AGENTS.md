# Setup guide for coding agents

You are an AI coding agent (Claude Code or similar) and a person has asked you to set this app up on their computer. Follow these steps in order. The human-facing version is in [README.md](README.md).

**What this app is:** a small Node server that lets the person's phone use Claude Code on this computer, over their private Tailscale network.

## Rules you must follow

1. **Never make the server reachable from the internet.** Do not change `HOSTS` to `0.0.0.0`, open firewall or router ports, or start a public tunnel (ngrok, Cloudflare Tunnel, Tailscale Funnel). Only `tailscale serve` is allowed.
2. **Never print the pairing key, the pairing link or the QR code into the chat.** `npm run pair` must be run by the person in their own terminal, or its output shown only on their screen.
3. **Never read or print** `data/token`, `data/passkeys.json`, or the person's passwords.
4. **Do not turn on `"terminal": true`** in `config.json` unless the person asks for the Terminal feature in their own words. If they do, tell them it runs commands with no approval step.
5. **Do not add the whole home folder** (`"folders": { "Home": "~" }`) unless the person asks for it.
6. Do not change Claude Code's permission settings, and do not run anything with `sudo` unless the person approves that exact command.
7. When a step needs the person (a login, a phone, a choice), **stop and ask them**. Do not guess.

## Steps

### 1. Find out where you are

Run `node -e "console.log(process.platform, process.version)"`.

- `linux`: continue. If `WSL_DISTRO_NAME` is set, this is WSL: treat it as Linux.
- `darwin`: macOS. Continue. Starting at login and "keep awake with the lid closed" work differently; see step 7.
- `win32`: tell the person that running inside **WSL2** is the supported way, and that joining a tmux session is not available outside WSL. Ask which they want before going on.

Node must be version 20 or newer. If it is missing or older, stop and tell the person.

### 2. Install packages

```bash
npm install
```

### 3. Make the settings file

```bash
cp config.example.json config.json
```

**Ask the person** which folders Claude may work in, and a short name for each. Then edit `config.json` so `projects` lists only those. Remove the sample entries, and remove `folders` and `voice` unless the person wants them (see step 8). Names may use letters, numbers, `.`, `_` and `-`.

### 4. Check Claude Code

Run `claude --version`. If it is missing, or the person has never signed in, **stop**: ask them to install Claude Code and run `claude` once to sign in. You cannot sign in for them.

### 5. Check Tailscale

Run `tailscale status`. If Tailscale is missing or signed out, **stop**: the person must install it on this computer and on the phone, and sign in to the same account on both. You cannot do the sign-in.

Then give the app a private HTTPS address:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

If port 443 is already used by `tailscale serve`, pick another, such as `--https=8443`. If Tailscale says HTTPS is not enabled for the account, give the person the link it prints and wait.

### 6. Start it and run the check

```bash
npm start
```

Leave it running (use a background process), then in another shell:

```bash
npm run doctor
```

Every line must say `ok` or `skip`. For each `FAIL`, apply the fix it prints and run it again. Setup is done only when `npm run doctor` exits with code 0.

### 7. Start it automatically (ask first)

Ask the person if they want the app to start when the computer starts.

- **Linux:** create the systemd user service shown under "Start it automatically" in the README, with `WorkingDirectory` set to this folder. Then `systemctl --user enable --now tether`. If Node is installed through a version manager, set `ExecStart` to the full path from `which node`.
- **macOS:** create a `launchd` agent in `~/Library/LaunchAgents` that runs `node server.mjs` in this folder with `RunAtLoad` and `KeepAlive`. This path has not been tested by the project yet: say so.
- **Windows (not WSL):** not covered yet. Say so.

### 8. Optional features (only if asked)

- **Voice notes:** follow "Voice notes" in the README (a Python environment with `faster-whisper`, then download the model once). Set `voice.python` in `config.json`.
- **Joining a Claude Code that is open in tmux:** add `"tmux": "<session name>"` to that project in `config.json`. Needs tmux.
- **Extra folders in Files:** add them under `folders`.

Restart the server after changing `config.json`, then run `npm run doctor` again.

### 9. Hand over to the person

Tell them, in this order:

1. Run `npm run pair` in their own terminal and scan the QR code with the phone's camera. The phone must be connected to Tailscale.
2. Install the app from the phone's browser: "Add to Home screen" (Android Chrome) or Share → "Add to Home Screen" (iPhone Safari).
3. In the app, open **Settings** and turn on **Fingerprint lock**. Recommend this strongly.
4. If the computer is a laptop that should stay reachable, turn on **Keep computer awake** in Settings.
5. Read the "Safety" section of the README.

## If something goes wrong

- `npm start` exits with "No projects yet": `config.json` is missing or has no `projects`.
- `npm start` exits with "Refusing to start": `HOSTS` is set to every network. Unset it.
- The phone can't open the address: check Tailscale is connected on both, and `tailscale serve status` shows the port forwarding to `127.0.0.1:8787`.
- "That key was not accepted" on the phone: the key changed. Run `npm run pair` again.
- Locked out by the fingerprint lock: on the computer, delete `data/passkeys.json` and `data/remembered.json`, restart the server, and pair again.
