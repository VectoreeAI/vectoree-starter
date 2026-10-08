# Vectoree Starter

A small local app for trying Vectoree: link a project, sign up an app user, then chat (including an image). The project API key stays on the server.

## Run

Requirements: Node.js 20+.

```bash
./dev.sh
```

That installs when `node_modules` is missing or older than `package-lock.json`, then runs `npm run dev`. The same two commands still work on their own:

```bash
npm install
npm run dev
```

- Web: http://127.0.0.1:5173
- BFF: http://127.0.0.1:8787 (localhost only, unless `HOST` is set)

`npm run dev` starts both. The browser talks only to the Vite server, which proxies `/api` to the BFF.

## Docker

Requirements: Docker with Compose. This does not replace the host link step.

```bash
docker compose up --build
```

- Web: http://localhost:5173
- BFF inside the compose network: `server:8787` (not published on the host)

Compose sets `HOST=0.0.0.0` so the BFF accepts traffic from the web container. Local `npm run dev` still binds `127.0.0.1`. The web container proxies `/api` to `http://server:8787` (`API_PROXY`). The browser stays on port 5173, so the session cookie stays same-origin.

Volume: `./.vectoree` → `/app/.vectoree` (project link and chat history). Compose does not mount `.env`; it passes it to the BFF as an optional `env_file`, so variables set there reach the container and a missing file is fine.

### Cloud preview mode

Set `DEPLOY_MODE=cloud` in `.env` to run the starter as the hosted preview behind Vectoree's template **Preview** button. There is no link step and no settings key form:

```bash
# .env
DEPLOY_MODE=cloud
VECTOREE_API_URL=http://host.docker.internal:7130   # Vectoree backend as seen from the BFF container
```

On the Vectoree side, set `STARTER_PREVIEW_BASE_URL` to this app's URL (for example `http://127.0.0.1:5173/starter/`). Clicking Preview opens `…/starter/?ticket=…`. The BFF redeems the ticket once with `POST /api/system/starter/preview/redeem`, keeps the returned project key on the server, and gives the browser an httpOnly `ve_preview` cookie. Tickets are single use and expire after 60 seconds; the preview itself expires after 12 hours idle. Each visitor gets their own project, app users, and chat history (`.vectoree/conversations/<projectId>/<userId>/`).

Previews live in BFF memory. Restarting the server drops them, and visitors see **Preview expired** until they click Preview in Vectoree again.

**Connect through a forwarded port:** open the app at `http://127.0.0.1:5173/starter/` (or `http://localhost:5173/starter/`). Click **登录 Vectoree**. After Console login, the browser returns to `http://127.0.0.1:5173/starter/api/setup/callback` on that same forwarded port, which redirects back into the app. The web server proxies it to the BFF. You can also mount a `.vectoree/config.json` written elsewhere. If a previous `docker compose up` already created a directory named `.env`, remove that directory before relying on a real env file.

## Link a project

Primary path is inside the app. See [vectoree.ai/SKILL.md](https://vectoree.ai/SKILL.md).

1. `npm run dev` and open the app. If the server has no project link yet, Setup shows **登录 Vectoree** (origin defaults to `https://vectoree.ai`).
2. Click it. The same tab goes to Vectoree Console login (PKCE, same family as `vectoree login`).
3. After you approve, Vectoree sends a code back to the starter. The page shows **正在登录** while the server exchanges it for a console access token, then **正在获取后端** while it lists your projects.
4. Pick a project (name and id are shown) and click **Link**. The server mints a project API key and writes:

`.vectoree/config.json` — `apiUrl`, `accessToken`, `refreshToken`, `apiKey`, `projectId`, `projectName`, `keyId`

`.env` — only:

```bash
VECTOREE_API_URL=https://vectoree.ai
VECTOREE_PROJECT_ID=your_project_id
VECTOREE_API_KEY=sk-ve-v1-...
```

Console tokens stay in `.vectoree/config.json`. They are not in `.env` and not sent to the browser. Do not prefix the key with `VITE_`.

The key mint uses `User-Agent: VectoreeCLI` plus `deviceId` and `localFolderPath`, so the Vectoree console can show the project as connected.

`VECTOREE_API_URL` is the origin only, with no `/api` suffix. On each request the server re-reads `.vectoree/config.json`, then `.env` / `.env.local`, then the process environment. A project id plus an `sk-ve-` key from one of those sources skips Setup. Deleting those files while `npm run dev` is running returns you to Setup: credentials written into memory by the link are dropped. A real shell export of `VECTOREE_*` (present when the process starts) still counts; CI should keep a `.env` on disk, or restart the process after unsetting exports.

`.vectoree/`, `.env`, and `.env.local` are gitignored.

## What the screens do

1. **Setup** — **登录 Vectoree**, then choose one of your projects and **Link**. That mints a project key (`User-Agent: VectoreeCLI`) and writes `.vectoree/config.json` (mode `0600` when the filesystem allows it) plus `.env`.
2. **Sign up / Sign in** — Vectoree App Auth through the BFF. New users get an 8-digit email code. The browser receives an httpOnly `ve_session` cookie, not the app JWT and not the project key.
3. **Chat** — streams `POST /api/v1/chat/completions`. The default model is the first catalog model with image input and text output, otherwise `vectoree/auto`. Attach a png, jpeg, webp, or gif (about 4MB) and it is sent as a vision `image_url` data URL.

**Image tool** (on by default) lets the chat model call `generate_image`. The BFF runs `POST /api/v1/images` with the project key and streams the picture back as `event: starter.images`. The image model is the first catalog model with image output. If the catalog has none, the tool stays off.

Restarting the BFF clears in-memory sessions. Sign in again.

## Manual test checklist

- [ ] Fresh start shows Setup with origin and **登录 Vectoree** only. There is no paste-key or CLI block.
- [ ] **登录 Vectoree** opens Console login in the same tab. After approval the app shows 正在登录, then 正在获取后端, then your projects with ids. **Link** writes `.vectoree/config.json` (console tokens and project key) and `.env` (only URL / project id / api key), shows Link 成功 with a 3-second countdown, and then Sign up opens. Status responses never include those secrets. The console project shows as connected.
- [ ] Sign up emails an 8-digit code; verifying it opens Chat. Resend is a separate button.
- [ ] Sign out returns to Sign in. Chat and `/api/models` answer 401 until you sign in again.
- [ ] A text message streams tokens into the thread.
- [ ] An attached image is visible in the thread and the reply refers to it when the selected model is vision-capable.
- [ ] `npm test` passes (setup responses never contain `sk-ve`).

## Scripts

| Command | What |
| --- | --- |
| `./dev.sh` | Install if needed, then web + BFF |
| `npm run dev` | Web + BFF |
| `npm run typecheck` | Typecheck both workspaces |
| `npm test` | BFF unit tests (no network) |
| `docker compose up --build` | Web + BFF in containers |
