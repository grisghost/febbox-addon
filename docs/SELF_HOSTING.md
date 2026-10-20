# Self-hosting

## Requirements
- Node.js 18+
- A FebBox account and its `ui` cookie value (each user supplies their own —
  see README "How users provide a token").

## Setup
```bash
git clone <this-repo>
cd febbox-addon
npm install
npm run build   # builds the config page (web/, a React app) into views/public/
cp .env.example .env
# edit .env: set CONFIG_SECRET (required) and TMDB_API_KEY (recommended)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # generate CONFIG_SECRET
npm start
```
The server listens on `PORT` (default `7000`). Visit `http://localhost:7000/`
for the configuration page. `npm run build` only needs to be re-run when
`web/` changes — `views/public/` (its output) is gitignored, not committed.

## Verifying it's running
```bash
curl -s localhost:7000/health
# {"ok":true}
```

## Installing in Stremio
1. Open the config page, paste your FebBox `ui` token, click "Validate token"
   to confirm FebBox accepts it, then "Generate install link".
2. Copy the resulting `https://<your-host>/<configToken>/manifest.json` URL.
3. In Stremio: Addons → paste the URL into the search/install box.

## Environment variables
See `.env.example`. `CONFIG_SECRET` is required — the server refuses to
start without it (fails loudly, see `src/app/index.js`). `TMDB_API_KEY` is
optional but recommended for IMDb→TMDB id conversion.

## Running tests
```bash
npm test            # unit tests, mocked upstream, no network/credentials needed
npm run test:manual # opt-in live FebBox check; needs FEBBOX_UI_TOKEN env var, auto-skips otherwise
npm run lint         # basic syntax check of the new src/app entry points
npm audit
```

## Deployment
Any Node-capable host that runs a persistent process works (the app is a
single Express process with no native build step, no database, no Redis).
It needs one long-running process — the in-memory caching and rate
limiting (`src/cache/ttlCache.js`, `src/security/rateLimit.js`) rely on
staying in one process's memory, so serverless/edge platforms that don't
guarantee a persistent process between requests aren't a good fit without
changes.

Set `CONFIG_SECRET` and `TMDB_API_KEY` as real environment variables in
your platform's secret manager — never commit `.env`. Build the config
page once before starting (`npm run build`, output is `views/public/`,
gitignored), then run `npm start`. Caches don't survive a process restart —
deliberate, since these are all safely re-fetchable and short-TTL links
shouldn't be persisted anyway.

## AIOStreams compatibility
Stream objects use standard Stremio `behaviorHints.filename` and
`bingeGroup` fields (`src/stremio/routes.js:toStreamObjects`) so downstream
aggregators like AIOStreams can parse quality/language from the filename the
same way they do for other addons. This has not been verified against a
live AIOStreams instance in this environment.

## Known limitations (read before deploying)
- **HLS quality tiers (1080p/720p/360p/etc.) are excluded by default.**
  FebBox serves these as HLS with long (~10.4s) segments, which Stremio's
  web client doesn't seek reliably. Only FebBox's direct "ORG" (original,
  untranscoded) file is offered by default (`playbackMode: "direct"`).
  Users can opt into `experimental-hls` (HLS only) or `both` (direct +
  HLS) mode (config page → Advanced) to get the HLS tiers anyway, clearly
  labeled with a seeking warning — this addon does not proxy or transcode
  video to work around it.
- ORG files are the original source files and can be large (often several
  GB, sometimes 40GB+ for a movie) — expect correspondingly large
  bandwidth/time to stream, against the user's own FebBox quota.
- **Catalog discovery (matching a title to FebBox content) uses ShowBox's
  public site rather than a documented API** (see
  `docs/CATALOG_DISCOVERY_RESEARCH.md`) — reliable in practice, but could
  break without notice if ShowBox changes its markup or endpoints.

## Multiple tokens and automatic failover

On the config page you can add up to 5 FebBox tokens in priority order. Each time
a stream is requested the addon uses the first token that still has quota
(remaining quota is read from FebBox and cached for ~2 minutes); if FebBox
rejects a token (invalid / rate-limited / quota), it is paused for a while and the
next token is tried. Tokens with less than `MIN_REMAINING_MB` left (default 1024)
are only used when no other token has more room.

Note: FebBox counts quota when the video is *played*, so the switch happens the
next time a stream list is requested — it can't move a playback that is already
running to another token. With a single token nothing changes.

## Admin page

Set `ADMIN_PASSWORD` and open `/admin` over HTTPS; you sign in with that password on a login page (session cookie, 12 hours). Changing `ADMIN_PASSWORD` or `CONFIG_SECRET` signs everyone out.
It lists every install the server has seen (name, last activity, request/error
counters, number of failovers) and, for each token, its status and remaining
quota (shown only as an 8-character hash prefix, never the token). From there you
can copy an install's addon link, edit its tokens, refresh quotas, block an install (it then receives no streams), or remove it
from the list. Installs are recorded in `DATA_DIR/registry.json`; on hosts with an
ephemeral disk the list resets on redeploy. Because install URLs are stateless,
"block" works by install id and cannot revoke the URL itself — rotate
`CONFIG_SECRET` to invalidate every install at once.

### Editing tokens from the admin page

"Edit tokens" on an install lets you replace, add, remove and reorder its tokens
(max 5) **without changing its addon URL** — nothing to reinstall in Stremio.
New tokens are checked against FebBox before saving. The override is stored
encrypted (with `CONFIG_SECRET`) in `DATA_DIR/registry.json`, and existing tokens
are only ever shown as 8-character hashes. "Reset to original" goes back to the
tokens inside the URL. If `DATA_DIR` is not on a persistent volume, an override is
lost on redeploy and the install falls back to the URL's tokens.
