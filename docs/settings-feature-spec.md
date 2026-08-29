# Consolidated Settings — feature spec & shared contract (v1.23.0)

> Working doc for the `feature/consolidated-settings` branch. Four agents build
> disjoint slices against the contract below. The lead integrates, live-verifies,
> and updates CLAUDE.md / README / TODO / VERSION. This file may be removed or
> folded into CLAUDE.md before the release PR.

## Goal

Replace the scattered toolbar/persona-panel preference controls with a single
**Settings lightbox** (opened from the profile dropdown, next to Sign out).
Per-user preferences persist **server-side** in a new `settings-service`
(FastAPI + stdlib SQLite). Defaults come from environment variables.

---

## Shared contract (do not deviate — every agent builds against these)

### HTTP API — `settings-service`, reached at `https://localhost/settings`

Every request carries `X-Auth-User: <username>`, injected by nginx from the
auth sub-request. The service MUST reject a request whose `X-Auth-User` is
missing or does not match `^[A-Za-z0-9_-]{1,64}$` with 401 (defence-in-depth
behind the nginx `auth_request` gate). A client-supplied `X-Auth-User` is
overwritten by nginx `proxy_set_header`, so the service can trust it.

**`GET /settings`** → 200

```json
{
  "global": {
    "chat_model": "gemma4:e4b", "vision_model": "gemma3:4b",
    "tts_engine": "piper", "auto_speak": false, "stt_lang": "en-US",
    "thinking_enabled": false, "thinking_depth": "medium",
    "nav_rail": true, "active_persona": "englishEditor"
  },
  "personas": {
    "englishEditor": {"thinking_enabled": null, "thinking_depth": null, "tts_engine": null, "editor_mode": "clean"},
    "assistant":     {"thinking_enabled": null, "thinking_depth": null, "tts_engine": null},
    "casual": {"...": "..."}, "claudePromptCompressor": {}, "creative": {},
    "legal": {}, "medical": {}, "professional": {}, "teacher": {},
    "technical": {}, "transcriptai": {}
  },
  "defaults": {
    "global": { "chat_model": "gemma4:e4b", "...": "...same keys as global, from env..." },
    "persona": {"thinking_enabled": null, "thinking_depth": null, "tts_engine": null, "editor_mode": "clean"}
  }
}
```

- `global` = env defaults overlaid with the user's stored `global` rows.
- `personas[key]` = the user's stored overrides; an unset override is `null`
  ("inherit the global value"). `editor_mode` appears only under `englishEditor`,
  is never `null`, defaults to `"clean"`.
- `defaults` = what a reset lands on (for the UI's "(default: X)" hints).

**`PUT /settings/global`** — body `{ "<key>": <value>, ... }` (any subset of the
global keys). → 200 `{"ok": true, "global": {…updated resolved global…}}`.
Unknown key or bad enum/type → 422 `{"ok": false, "error": "..."}`.

**`PUT /settings/persona/{personaKey}`** — body `{ "<key>": <value|null>, ... }`.
`null` deletes that override row. → 200 `{"ok": true, "persona": {…updated…}}`.
`personaKey` not one of the 11 → 404. `editor_mode` for a non-`englishEditor`
persona → 422.

**`POST /settings/reset`** — body
`{ "scope": "global" | "persona:<key>" | "all", "keys": ["k1", ...] }` (`keys`
optional). With `keys`, delete only those rows in that scope; without, delete
the whole scope; `"all"` deletes every row for the user. → 200 `{"ok": true}`.

**`GET /health`** → `{"status": "ok"}` — not proxied publicly, no auth.

### Canonical keys & valid values

Global:

| key | type / values |
|---|---|
| `chat_model` | non-empty string |
| `vision_model` | non-empty string |
| `tts_engine` | `"piper"` \| `"voicebox"` |
| `auto_speak` | bool |
| `stt_lang` | string matching `^[a-z]{2}(-[A-Za-z0-9]{2,8})*$` |
| `thinking_enabled` | bool |
| `thinking_depth` | `"low"` \| `"medium"` \| `"high"` |
| `nav_rail` | bool |
| `active_persona` | one of the 11 persona keys |

Persona override (all nullable = "inherit", except `editor_mode`):
`thinking_enabled` (bool\|null), `thinking_depth` (`low`\|`medium`\|`high`\|null),
`tts_engine` (`piper`\|`voicebox`\|null), `editor_mode`
(`clean`\|`changes`\|`explain`, **englishEditor only, non-null**, default `clean`).

The 11 persona keys (must match `src/aia/scripts/config.js` `systemPrompts` minus
`englishEditorExplained`): `assistant`, `casual`, `claudePromptCompressor`,
`creative`, `englishEditor`, `legal`, `medical`, `professional`, `teacher`,
`technical`, `transcriptai`.

### `.env` default keys (all optional; service bakes in the fallback shown)

| env var | fallback |
|---|---|
| `VPAL_DEFAULT_CHAT_MODEL` | `gemma4:e4b` |
| `VPAL_DEFAULT_VISION_MODEL` | `gemma3:4b` |
| `VPAL_DEFAULT_TTS_ENGINE` | `piper` |
| `VPAL_DEFAULT_AUTO_SPEAK` | `false` |
| `VPAL_DEFAULT_STT_LANG` | `en-US` |
| `VPAL_DEFAULT_THINKING` | `false` |
| `VPAL_DEFAULT_THINKING_DEPTH` | `medium` |
| `VPAL_DEFAULT_NAV_RAIL` | `true` |

`active_persona` default is always `englishEditor` (not env-configurable in v1).

### Service / infra names

- Service dir `settings-service/`, container `vpal-settings`, listens `:8005`,
  compose `expose: "8005"`, nginx upstream `settings_service`.
- SQLite at `/data/settings.db` (WAL mode). `/data` is a **named volume**
  `vpal-settings-data` — NOT tmpfs (must persist; WAL needs the directory
  writable for `-wal` / `-shm`). Root FS stays `read_only: true`.
- nginx: `location ^~ /settings/` **and** `location = /settings` — both:
  `auth_request /auth/verify;` · `auth_request_set $auth_user $upstream_http_x_auth_user;`
  · `proxy_set_header X-Auth-User $auth_user;` · `error_page 401 = @login_redirect;`
  · `limit_req zone=settings burst=10 nodelay;`. New zone
  `limit_req_zone $binary_remote_addr zone=settings:1m rate=30r/m;`.
  Template placeholder `${SETTINGS_UPSTREAM}` default `settings-service:8005`.
- auth: `GET /auth/verify` returns header `X-Auth-User: <username>` on 200.

### Frontend globals & functions

`config.js`:
- `const SETTINGS_API_URL = 'https://localhost/settings';`
- keep `const VISION_MODEL_NAME = 'gemma3:4b';` as the fallback; add
  `let currentVisionModel = VISION_MODEL_NAME;`

`window.vpalSettings` — the object from `GET /settings` (or a defaults-shaped
object built from `config.js` constants on failure). Written by `main.js` after
hydration; read by `settings.js`.

`settings.js` (loaded after `nav-rail.js`, before `main.js`) — global functions:
- `initSettings()` — build the hidden lightbox DOM into `#settingsRoot`; wire
  nav / per-category Save+Cancel / per-section + per-field + "Reset all". Idempotent.
- `openSettings(categoryId)` — show lightbox, select category
  (`'models'|'voice'|'reasoning'|'interface'|'personas'`, default `'models'`);
  re-reads `window.vpalSettings` on each open.
- `closeSettings()`.
- `applyResolvedSettings()` — from `window.vpalSettings`, set `currentModel`,
  `currentVisionModel`, `currentTTSEngine` (persona-resolved), `currentThinkingMode`
  (persona-resolved → `'off'` when disabled else the depth), `currentNavRailEnabled`
  (+ `window.` mirror + call `setNavRailEnabled`), `currentEditorMode`,
  `currentSystemPrompt` (reuse `_resolveSystemPrompt` with the active persona),
  and refresh `#modelBadge` / `#thinkingBadge`.
- Pure, Node-exported for Jest:
  `resolveSetting(key, personaKey, vpalSettings)` (persona override → global → default),
  `resolveThinkingMode(personaKey, vpalSettings)` → `'off'|'low'|'medium'|'high'`,
  `resolveTtsEngine(personaKey, vpalSettings)`,
  `diffSettings(formValues, resolvedValues)` → changed-subset object,
  `buildMigrationPayload(localStorageSnapshot)` → `{ global: {...}, personas: {...} }`.

DOM ids:
- `#settingsRoot` — empty `<div>`, added by Agent D (near `#navRail`, last children of `.chat-container`).
- `#settingsMenuItem` — `<button>` in `#profileDropdown`, after a new
  `<hr class="dropdown-divider">`, immediately before the logout `<form>`.
- `#modelBadge`, `#thinkingBadge` — non-interactive-looking `<button>`s in
  `.toolbar-left`; click → `openSettings('models')` / `openSettings('reasoning')`.
  Agent D adds the elements; Agent C styles them and fills their text in
  `applyResolvedSettings()`.
- Lightbox internals (Agent C, built in JS): `#settingsLightbox`,
  `#settingsBackdrop`, `#settingsNav`, `#settingsPanel`, `#settingsResetAll`,
  `.settings-category[data-category]`, `.settings-save`, `.settings-cancel`,
  `.settings-section-reset`, `.settings-field-reset`.

CSS (Agent C, appended to `style.css`) — `/* ===== Settings lightbox ===== */`,
every selector scoped under `#settingsRoot` / `#settingsLightbox` /
`#settingsBackdrop` / `.settings-*` / `#modelBadge` / `#thinkingBadge`. Reuse
existing literal colours (`#0f172a`, `#0ea5e9`, `#e0f2fe`, `#0369a1`, `#94a3b8`,
`#cbd5e1`, `#1e293b`, the `.toast` dark palette). `@media (max-width: 600px)`
stacks the two panes (nav → top, or a list→detail→back flow). Focus-trap the
lightbox (Agent C may reuse the `_trapFocus` pattern from `main.js` — but that
fn is Agent D's file; Agent C implements its own local trap inside `settings.js`).

### Migration (Agent D, in `main.js`)

Guard on `localStorage['settingsMigrated'] === '1'`. If not set, snapshot the
legacy keys and `PUT` them up once via `buildMigrationPayload`:

| legacy localStorage | → |
|---|---|
| `ollamaModel` | global `chat_model` |
| `ttsEngine` | global `tts_engine` |
| `autoTTS` (`"true"`) | global `auto_speak` |
| `thinkingOn` (`"true"`) + `thinkingDepth` | global `thinking_enabled` / `thinking_depth` |
| `navRailEnabled` | global `nav_rail` |
| `editorMode` | persona `englishEditor` → `editor_mode` |
| `personaPrefs` (JSON `{key:{thinkingOn,thinkingDepth,ttsEngine}}`) | per-persona `thinking_enabled` / `thinking_depth` / `tts_engine` |

After a successful migration `PUT`, remove those legacy keys and set
`localStorage['settingsMigrated'] = '1'`.

### Resilience (Agent D)

`GET /settings` fails on load → build `window.vpalSettings` from the `config.js`
constants (defaults shape), `applyResolvedSettings()`, `showToast('Settings
service unavailable — using defaults')`. The lightbox still opens but shows a
"can't connect / Retry" state with Save disabled (Agent C renders that state
when `window.vpalSettings.__unavailable === true`).

### Save UX

Right pane shows one category at a time. Each category panel has its own
**Save** + **Cancel** + **Reset this section**; the lightbox footer has
**Reset all**. Each field whose current value differs from its default shows a
small ↺ (per-field reset). Switching category with unsaved edits → inline
confirm ("Discard unsaved changes in <category>?"). Save → `PUT` → on 200 update
`window.vpalSettings` + `applyResolvedSettings()` + toast; **no reload**.
Persona picker (active persona) is **disabled while a conversation is active**
(`conversationHistory.length > 0`) with a visible note.

### eslint.config.js (Agent D)

Add: `SETTINGS_API_URL: 'readonly'`, `currentVisionModel: 'writable'`,
`vpalSettings: 'writable'`, and a `// settings.js` group with `initSettings`,
`openSettings`, `closeSettings`, `applyResolvedSettings`, `resolveSetting`,
`resolveThinkingMode`, `resolveTtsEngine`, `diffSettings`, `buildMigrationPayload`
all `'readonly'`.

---

## Agent scopes (mutually exclusive — no shared files)

- **A — settings-service backend.** Only `settings-service/**` (new). FastAPI +
  stdlib `sqlite3` (WAL), Dockerfile mirroring `doc-extract/Dockerfile` (port
  8005), `requirements*.txt`, `pytest.ini`, `.dockerignore`, `tests/`. Implements
  the HTTP API + validation + env defaults + reset semantics above.

- **B — auth header + infra.** `auth/main.py` + `auth/tests/test_main.py`
  (add `X-Auth-User` on `/auth/verify`), `deploy/nginx/nginx.conf.template` +
  regenerated `deploy/nginx/nginx.conf` + `deploy/nginx/render-nginx-conf.sh`
  (add `${SETTINGS_UPSTREAM}` to the allowlist), `docker-compose.yml`
  (`settings-service` + `vpal-settings-data` volume), `.github/workflows/ci.yml`
  (7th job `settings-service-lint-test` mirroring `doc-extract-lint-test`; add
  `settings-service` to `nginx-config-check`'s /etc/hosts stubs + cloud-render
  env), `.env.example` (the 8 `VPAL_DEFAULT_*` keys).

- **C — Settings lightbox module.** Only `src/aia/scripts/settings.js` (new),
  `tests/js/settings.test.js` (new), and appended CSS in `src/aia/css/style.css`.
  Builds the lightbox DOM, per-category Save/Cancel/Reset, model dropdowns via
  `parseOllamaModels()`, the resilience/error state, badges styling + text.

- **D — frontend integration.** `src/aia/index.html` (remove the old controls
  and `#personaPanel`; add `#settingsMenuItem`, `#settingsRoot`, `#modelBadge`,
  `#thinkingBadge`; `settings.js` script tag after `nav-rail.js`),
  `src/aia/scripts/config.js`, `src/aia/scripts/main.js` (hydration + migration
  + wiring; delete old per-control wiring), `src/aia/scripts/api.js`
  (`currentVisionModel`), `src/aia/scripts/chat.js` (persona/editor state from
  `vpalSettings`; drop `#personaPanel`/`#editorModeSelect` refs),
  `eslint.config.js`.

## Verification gate (lead, after integration)

`npm run lint:js` · `npm run lint:html` · `npm run check:sri` · `npx jest` ·
each Python suite's `black --check` + `flake8` + `pytest` ·
`nginx -t` on the rendered config · **live**: `docker-compose up`, TOTP login,
change a setting, confirm it persists across a container restart and that the
SQLite file lives on the volume.
