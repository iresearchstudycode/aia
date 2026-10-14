# Session Status — 2026-10-14 (rev 19)

Handoff note for resuming work. Overwrite freely.

## Where things are

| | |
|---|---|
| `master` / `dev` | **v1.36.4** at `d82684c` (PR #98), identical, zero drift. Open PRs: **0** (before the docs/feature PR below). |
| GitHub alerts | Dependabot **0**, code scanning (CodeQL) **0**, secret scanning **0** — all closed over releases 1.36.2 → 1.36.4. |
| In flight | `docs/rebuild-note-clear-errors-refresh` → **v1.37.0**: "rebuild the service" error toasts for stale backends + README rebuild note + a full documentation/diagram refresh. PR into `dev`. |
| Docker stack | 7 containers healthy on the dev machine, images rebuilt from v1.36.4. **Any other machine must `docker-compose build --no-cache` before `up`** (see below). |

## What shipped since rev 18 (v1.34.0 → v1.37.0)

| Version | What |
|---|---|
| 1.34.1 | Nav-rail hover-card caret alignment; stale-image deploy docs |
| 1.35.0 | **Rename chats** from the sidebar (pencil / `F2`, inline editor). `conversations-service` gained `title_custom` (migrated in place) + `PUT /conversations/{id}/title`; auto-save no longer overwrites a custom title |
| 1.36.0 | **Cybersecurity Consultant persona** on the custom `cyber-consultant` Ollama model. VPAL sends **no system prompt** for it (Ollama replaces a Modelfile `SYSTEM` when one is sent — verified against the live model). New per-persona **`chat_model` override** (settings-service; house default via `VPAL_DEFAULT_CYBER_CHAT_MODEL`) |
| 1.36.1 | History groups **A→Z and stable**; chats newest-modified-first inside each group; persona-group icon 13 → 20 px |
| 1.36.2 | All **14 Dependabot alerts** closed (`pypdf` → 6.20.1, plus `browserslist` / `brace-expansion` / `baseline-browser-mapping`). Dev-tooling bumps merged (Jest 30.5.2, ESLint 10.12, globals 17.12) |
| 1.36.3 | **13 CodeQL alerts** closed: least-privilege workflow tokens, no exception text in error responses, percent-encoded cookies. `sprintf-js` (no patched release) removed from the tree via a scoped npm override → `npm audit` 0 |
| 1.36.4 | Last CodeQL alert (`py/cookie-injection`): cookies are issued for the **configured** username (`_canonical_username`), not the posted string |
| 1.37.0 | **Stale-backend errors** (the app says "rebuild the service" instead of a bare 422; one-time warning if history stops saving), README rebuild note, documentation + diagram review |

## ▶ Deploy gotchas (each bit us for real)

1. **`--force-recreate` does not rebuild.** A second machine pulled `master`, ran `docker-compose up -d --force-recreate`, and switching to the new persona failed with `PUT /settings/global 422` — its `settings-service` image still predated the persona. Fix: `docker-compose build --no-cache` then `up -d --force-recreate` (all services). v1.37.0 makes the UI say so.
2. **nginx caches backend addresses.** Recreating `auth`/`doc-extract`/`piper-tts`/`conversations` without recreating or reloading `web-server` left nginx calling the old IPs → every page **500** (`connect() failed (111) … upstream` in `docker logs vpal-nginx`; the containers themselves were healthy). Fix: recreate `web-server` with the backends, or `docker exec vpal-nginx /usr/sbin/nginx -s reload`. A permanent fix (a `resolver` + variable `proxy_pass`) is an nginx-template change, not done.
3. **Stale `auth` image** → Settings 401 (old `/auth/verify` lacked `X-Auth-User`). Documented since 2026-09-08.

Frontend (`src/aia/`) is bind-mounted: a page reload is enough. Backend changes always need build → recreate (+ `web-server`).

## ▶ Findings worth knowing

- **Every container gets the whole `.env`** (`env_file: .env` on all six Python services). Verified: `SECRET_KEY` is present in `vpal-settings`, `vpal-conversations`, `vpal-doc-extract`, `vpal-piper-tts` and `vpal-voicebox-proxy`, though only `auth` reads it. This is hardening **Finding C**, still open; earlier docs claimed the secret was "not shared" — corrected in `CLAUDE.md` and the README.
- **The "no server-side data at rest" property no longer holds.** `conversations-service` stores full conversation text (and `settings-service` preferences) in SQLite on named volumes. The cloud-hardening plan was written before that — see its addendum.
- **CodeQL's PR check only reports *new* alerts.** A clean PR check did not mean an existing alert was fixed (it wasn't, for the cookie one); only a re-scan of `master` shows that. CI itself runs on PRs to `dev` too.
- `cyber-consultant` is listed by Ollama as `cyber-consultant:latest`; the Settings dropdown treats the two names as one, but `resolveNumCtx`'s context map is keyed by the full name, so the persona uses the `OLLAMA_NUM_CTX` fallback (16384) — which happens to match the Modelfile's own `num_ctx`.

## ▶ Owed verification (needs a TOTP login — agents can't do this)

Verified so far only by unit tests, jsdom, an isolated harness and API calls. Sign in at `https://localhost/` (hard-reload) and check:

1. **Rename:** hover a chat → pencil → type → Enter; title changes, chat stays in its group and position; send another message in it → title is *not* reset. `F2` works; Escape cancels.
2. **History order:** persona groups A→Z and static while you chat; the active chat jumps to the top of *its own* group only. Persona-group icons are readable (20 px).
3. **Cybersecurity Consultant:** switch persona (header ▾), send "What does Essential Eight ML2 require for patching?" → an Australian-framework answer from `cyber-consultant`; the toolbar model badge shows the model; Settings → Personas → *Chat model* shows it selected (no "(not installed)").
4. **Stale-backend toast** (only reproducible on an old image): switching persona against an old `settings-service` shows the rebuild message, not just a console error.
5. Older, still open: themes full pass (Settings → Interface), and confirm the Ollama host's `OLLAMA_CONTEXT_LENGTH` suits large-window models (qwen3:4b → 262144).

## Next up

**Hardening** ([`hardening-status.md`](hardening-status.md), paused after Finding E): the plan predates `settings-service`/`conversations-service`; Finding **C** (per-service secrets) is now the most relevant, alongside a new data-at-rest item. Order otherwise: **D** (nginx `real_ip` / `X-Forwarded-Proto`), F, B (Redis auth state), N.

**Small follow-ups:** resolve nginx upstreams at request time; alias-aware context-length lookup (`name` ↔ `name:latest`); a no-VPAL-prompt persona's image turns currently get no persona prompt.

**Feature backlog:** remaining per-persona affordances (Transcript source pane + citations, Legal jurisdiction selector + disclaimer); document RAG instead of 28K truncation; OCR / encrypted-PDF in doc-extract.
