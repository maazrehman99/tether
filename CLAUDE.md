# Notes for Claude Code

If the person asks you to **set this app up**, follow [SETUP_FOR_AGENTS.md](SETUP_FOR_AGENTS.md) step by step. Its safety rules are not optional.

If the person asks you to **change the app**:

- `server.mjs` is the whole server (Node, no build). `public/` is the whole phone app (plain HTML, CSS and JavaScript, no framework, no build).
- Keep it dependency-light. Don't add a framework or a build step.
- All colours are variables at the top of `public/app.css`, once for dark and once for light. Keep text contrast at 4.5:1 or better.
- Anything that reads or writes files must go through `safePath()` in `server.mjs`. Never bypass it.
- Never make the server listen on every network, and never log or print `data/token` or a password.
- After a change, run `node --check server.mjs` and `node --check public/app.js`, then `npm run doctor`.
