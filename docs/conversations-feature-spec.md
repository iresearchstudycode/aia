# Conversation History — feature spec & shared contract (v1.25.0)

> Working doc for `feature/conversation-history`. Four agents build disjoint
> slices against the contract below. The lead integrates, live-verifies, and
> updates CLAUDE.md / README / TODO / VERSION. Remove this file (or fold into
> CLAUDE.md) before the release PR.

## Goal

An auto-saved, searchable list of past conversations, **persisted server-side
per authenticated user** in a new `conversations-service` (FastAPI + stdlib
SQLite). The manual JSON Save / Export MD / Open in the profile menu stay
unchanged — this is the convenience layer on top.

---

## Shared contract

### HTTP API — `conversations-service`, reached at `https://localhost/conversations`

Every request carries `X-Auth-User: <username>`, injected by nginx from the
auth sub-request (`/auth/verify` already emits this header — no auth change).
The service MUST reject a missing/malformed `X-Auth-User`
(`^[A-Za-z0-9_-]{1,64}$`) with 401. Every row is scoped to that username;
a request for another user's conversation id returns 404 (not 403 — don't
leak existence).

**`GET /conversations?q=&limit=&offset=`** → 200
```json
{ "conversations": [
    { "id": "c-...", "title": "...", "persona_key": "assistant",
      "created_at": "2026-08-30T...Z", "updated_at": "2026-08-30T...Z",
      "message_count": 8 }
  ],
  "total": 12, "cap": 100 }
```
Metadata only — **no `body`**. Newest-first by `updated_at`. `q` (optional) is a
case-insensitive `LIKE` filter on `title`. `limit` default 50 (max 200),
`offset` default 0.

**`GET /conversations/{id}`** → 200 the full record including
`"body": [ ...history array... ]` (parsed from stored JSON). 404 if the id
doesn't exist **or** isn't this user's.

**`PUT /conversations/{id}`** — body:
```json
{ "title": "string (<=200)", "persona_key": "one of the 11 or ''",
  "message_count": 0, "body": [ ...history array... ] }
```
Upsert. On first write set `created_at`; always set `updated_at` (server clock,
ISO-8601 Z). `body` is stored as `json.dumps(...)`; reject a serialized `body`
over **1 MiB** with 413. `message_count` must be a non-negative int. Unknown
top-level keys → 422. On a successful insert that would exceed
`CONVERSATIONS_MAX_PER_USER` (default 100) for this user, **delete the oldest
by `updated_at` until at cap** (so a PUT never fails for being at cap). →
200 `{ "ok": true, "id": "...", "created_at": "...", "updated_at": "..." }`.

**`DELETE /conversations/{id}`** → 200 `{ "ok": true }` (also 200 if it was
already gone / not the user's — idempotent, no existence leak).

**`GET /conversations/search?q=`** → 200 same shape as `GET /conversations`
but the `LIKE` also matches `body` (message text). `q` required (400 if empty).
Same newest-first ordering, honours `limit`/`offset`.

**`GET /health`** → `{"status": "ok"}` — not proxied publicly, no auth.

### IDs

The **client** generates the id (so it can PUT immediately on the first turn):
`'c-' + <ISO-ish timestamp> + '-' + <random>` — treat it opaquely, just
validate `^[A-Za-z0-9_-]{1,64}$` server-side.

### `.env` keys (optional, fallbacks baked in)

| var | fallback |
|---|---|
| `CONVERSATIONS_DB_PATH` | `/data/conversations.db` |
| `CONVERSATIONS_MAX_PER_USER` | `100` |

### Service / infra names

- Dir `conversations-service/`, container `vpal-conversations`, listens `:8006`,
  compose `expose: "8006"`, nginx upstream `conversations_service`.
- SQLite at `$CONVERSATIONS_DB_PATH` (WAL). `/data` is a **named volume**
  `vpal-conversations-data` (NOT tmpfs). Dockerfile seeds `/data` with
  uid-65532 ownership exactly like `settings-service/Dockerfile` does
  (builder `mkdir -p /app/data_seed && : > /app/data_seed/.keep`; runtime
  `COPY --from=builder --chown=65532:65532 /app/data_seed/ /data/`).
- nginx: `location = /conversations` **and** `location ^~ /conversations/` —
  both: `auth_request /auth/verify;` · `error_page 401 = @login_redirect;` ·
  `auth_request_set $auth_user $upstream_http_x_auth_user;` ·
  `proxy_set_header X-Auth-User $auth_user;` ·
  `limit_req zone=conversations burst=20 nodelay;` ·
  `limit_except GET PUT DELETE { deny all; }` · standard proxy_set_header set.
  New zone `limit_req_zone $binary_remote_addr zone=conversations:1m rate=60r/m;`
  (writes fire after every completed turn). `client_max_body_size 2m` on both
  (bodies carry a full history). Template placeholder `${CONVERSATIONS_UPSTREAM}`
  default `conversations-service:8006` — the **10th** placeholder.

### Frontend — `history.js` (new; loaded after `settings.js`, before `main.js`)

`config.js`: `const CONVERSATIONS_API_URL = 'https://localhost/conversations';`

Globals `history.js` exposes:
- `initHistory()` — build the hidden lightbox into `#historyRoot`; wire search /
  cards / "New chat" / delete / backdrop / Escape / focus-trap. Idempotent.
- `openHistory()` / `closeHistory()`.
- `hcCurrentId()` → the current conversation's id (or `null` before the first turn).
- `hcNewConversationId()` → mint + set a fresh current id, return it.
- `hcArchiveCurrent()` → **async**; if there is a current id and
  `conversationHistory.length > 0`, `PUT /conversations/{id}` the current record
  (built via `conversationRecordFrom`). Swallows/logs errors (never throws).
  Called by `chat.js` `clearChat()` **before** it wipes, and internally before
  loading another conversation.
- `hcTouchCurrent()` → **async**; ensure a current id exists (mint if not), then
  `PUT` the current record. Called from the turn-complete path in `api.js`.
  Debounce/coalesce rapid calls is fine. Never throws.
- `hcLoadConversation(id)` → **async**; `GET /conversations/{id}`, set
  `conversationHistory = body`, `renderConversationHistory()`, set current id to
  `id`, `closeHistory()`. On failure: `showToast(...)`, leave state untouched.
- Pure, Node-exported for Jest:
  - `chatTitleFrom(history)` → first user message → a trimmed ~6-word / ≤60-char
    title; `'New conversation'` when there is no user text. Strips a document
    block via `parseDocumentMessageContent` first if available.
  - `conversationRecordFrom(id, history, personaKey)` → `{ id, title,
    persona_key: personaKey || '', message_count: history.length, body }` where
    `body` is `history` with `imageBase64`/`imageDataUrl` stripped and `hasImage`
    kept (reuse the same shape `chat.js` `saveChat()` produces — copy that
    mapper's logic; do NOT import from chat.js).
  - `filterConversations(list, query, searchBody)` → client-side predicate over
    a already-fetched metadata list: case-insensitive substring on `title`
    (and, if `searchBody` and the item carries a `body`/`preview`, on that too).
    Used for instant local filtering; the "search message text" path calls
    `GET /conversations/search` for the authoritative result.

DOM ids (Agent D adds the anchors; Agent C builds the lightbox internals):
- `#historyMenuItem` — `<button>` in `#profileDropdown`, **above** the Settings
  item (before `#settingsMenuItem` and its preceding `<hr>`).
- `#historyRoot` — empty `<div>`, child of `.chat-container` next to
  `#settingsRoot` / `#navRail`.
- `<script src="./scripts/history.js">` — after `settings.js`, before `main.js`.
- Lightbox internals (Agent C): `#historyBackdrop`, `#historyLightbox`,
  `#historySearch`, `#historySearchBodyToggle`, `#historyList`,
  `#historyNewChatBtn`, `#historyEmpty`, `.history-card[data-id]`,
  `.history-card-title`, `.history-card-meta`, `.history-card-delete`,
  `#historyFooter` (count / cap / storage line).

CSS: Agent C appends a `/* ===== Conversation history lightbox ===== */`
section to `style.css`, scoped under `#historyRoot` / `#historyLightbox` /
`#historyBackdrop` / `.history-*`. Reuse the Settings-lightbox palette and the
`@media (max-width: 600px)` stack pattern.

### Auto-save wiring (Agent D)

- `api.js` — at the **turn-complete** points (next to the existing
  `if (typeof _refreshTurnControls === 'function') _refreshTurnControls();`
  calls — the success path, the abort-with-partial-content path, and the
  `finally`): add `if (typeof hcTouchCurrent === 'function') hcTouchCurrent();`.
- `chat.js` — `clearChat()` becomes **"New chat"**: `await hcArchiveCurrent()`
  (if present), then wipe `conversationHistory` + `#chatMessages`, then
  `hcNewConversationId && hcNewConversationId()` is NOT called here (a fresh id
  is minted lazily by `hcTouchCurrent` on the next turn). Drop the
  `confirm(...)` — nothing is lost now. Keep `stopSpeaking()` etc.
- `main.js` — on `DOMContentLoaded`: `initHistory()`. Wire `#historyMenuItem` →
  `openHistory()` (+ close the profile dropdown). `beforeunload` handler:
  `if (typeof hcTouchCurrent === 'function') { navigator.sendBeacon?.(...) }` —
  Agent C should expose a `hcBeaconSave()` that builds the PUT and uses
  `navigator.sendBeacon(CONVERSATIONS_API_URL + '/' + id, blob)` (Blob with
  `type: 'application/json'`); `main.js` calls that from `beforeunload`.
- The profile-menu "Clear" item label → **"New chat"** in `index.html`
  (`#clearBtn` keeps its id; only the text + icon may change).

### Settings backup (Agent D, in `settings.js`)

A "Backup" section/row in the Settings lightbox (any category footer, or a new
tiny "Backup" nav item — Agent D's call, keep it simple):
- **Export settings** → `GET SETTINGS_API_URL` → download the JSON as
  `vpal-settings-<date>.json`.
- **Import settings** → hidden `<input type="file">` → parse JSON →
  `PUT SETTINGS_API_URL + '/global'` with the `global` object, then
  `PUT .../persona/<k>` for each persona entry → re-`GET` → `applyResolvedSettings()`
  → toast. Validate it looks like a settings export (`.global` object present);
  otherwise toast "Not a settings file".

### eslint.config.js (Agent D)

Add: `CONVERSATIONS_API_URL: 'readonly'`, and a `// history.js` group with
`initHistory`, `openHistory`, `closeHistory`, `hcCurrentId`,
`hcNewConversationId`, `hcArchiveCurrent`, `hcTouchCurrent`,
`hcLoadConversation`, `hcBeaconSave`, `chatTitleFrom`, `conversationRecordFrom`,
`filterConversations` — all `'readonly'`.

### Resilience

Any `/conversations` call failing → `console.error` + (for user-initiated
actions) a toast; auto-save failures are silent and just retried on the next
turn. Chat itself never blocks on the history service.

---

## Agent scopes (mutually exclusive)

- **A — conversations-service backend.** Only `conversations-service/**` (new).
  Clone `settings-service/` structure (Dockerfile incl. the `/data` seed dance,
  `requirements*.txt`, `pytest.ini`, `.dockerignore`, `conftest.py` pointing
  `CONVERSATIONS_DB_PATH` at a tmp file). Implement the HTTP API + per-user
  scoping + eviction + 1 MiB cap + validation above. pytest mirroring
  settings-service's coverage.
- **B — infra.** `deploy/nginx/nginx.conf.template` (+ regenerate
  `deploy/nginx/nginx.conf`) + `deploy/nginx/render-nginx-conf.sh`
  (`${CONVERSATIONS_UPSTREAM}` → allowlist + default `conversations-service:8006`,
  "9 → 10 placeholders"), `docker-compose.yml` (`conversations-service` +
  `vpal-conversations-data` volume, mirroring the `settings-service` block —
  cpus 0.5 / memory 192M / pids 40), `.github/workflows/ci.yml`
  (`conversations-service-lint-test` cloned from `settings-service-lint-test`;
  add `conversations-service` to `nginx-config-check` `/etc/hosts` stubs +
  `CONVERSATIONS_UPSTREAM` to the cloud-render env), `.env.example`
  (the 2 keys). **Do NOT touch `auth/`** — `/auth/verify` already emits
  `X-Auth-User`.
- **C — history.js + lightbox.** Only `src/aia/scripts/history.js` (new),
  `tests/js/history.test.js` (new), and appended CSS in `src/aia/css/style.css`.
- **D — frontend integration.** `src/aia/index.html`, `src/aia/scripts/chat.js`,
  `src/aia/scripts/api.js`, `src/aia/scripts/main.js`, `src/aia/scripts/config.js`,
  `src/aia/scripts/settings.js`, `eslint.config.js`,
  `CLAUDE.md` / `README.md` (history + backup docs).

## Verification gate (lead)

`npm run lint:js` · `lint:html` · `check:sri` · `npx jest` · each Python suite
(`black --check` + `flake8` + `pytest`) · nginx drift guard + `nginx -t` ·
`docker compose config` · **live**: `docker compose up`, TOTP login, send a few
turns, confirm they appear in History, search, load an old one, delete one,
push past the cap and see eviction, restart `conversations-service` and confirm
persistence, round-trip a settings export/import.
