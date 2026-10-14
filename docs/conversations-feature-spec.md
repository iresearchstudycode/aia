# Conversation History — HTTP contract & behaviour (reference)

> **Status: implemented and shipping** (introduced in v1.25.0; this file is now the reference
> for the `conversations-service` HTTP contract, updated through **v1.36.x**). It began life as a
> build-time task sheet for parallel agents; those instructions are gone. For the frontend
> (`history.js`) see the *JavaScript Module Architecture* and *Conversation History* sections of
> [`CLAUDE.md`](../CLAUDE.md); for operations see the [README](../README.md).

## What it is

An auto-saved, searchable list of past conversations, **persisted server-side per authenticated
user** by `conversations-service` (FastAPI + stdlib `sqlite3`, WAL). It is a convenience layer on
top of the manual JSON Save / Export MD / Open (in the chat header's "⋯" menu), which are
unchanged. The list is rendered **inline in the left sidebar**, grouped by persona.

> **Data at rest:** this service stores each user's **full conversation text** in SQLite on the
> `vpal-conversations-data` volume (and `settings-service` stores preferences on
> `vpal-settings-data`). Back up, encrypt and retain those volumes accordingly — see the addendum in
> [`cloud-hardening-plan.md`](cloud-hardening-plan.md).

---

## HTTP API

Reached at `https://localhost/conversations` through nginx. Every request carries
`X-Auth-User: <username>`, set by nginx from the auth sub-request (it **overwrites any
client-supplied value**). The service rejects a missing or malformed value
(`^[A-Za-z0-9_-]{1,64}$`) with `401`, scopes every row to that user, and answers a request for
another user's id with `404` (never `403`) so existence isn't leaked.

**Error shapes.** Validation failures are `{"ok": false, "error": "<message>"}` — status `422`, or
`413` for an oversize body (a dedicated `PayloadTooLargeError`). The message is always a fixed,
developer-written string; the service never returns exception text. `404` is `{"error": "not found"}`.

| Method & path | Purpose |
|---|---|
| `GET /conversations?q=&limit=&offset=` | Metadata list, newest-first by `updated_at`. `q` filters `title` (case-insensitive `LIKE`). `limit` default 50 (max 200), `offset` default 0. **No `body`.** |
| `GET /conversations/search?q=` | Same shape, but `q` (required; `400` if empty) also matches message text. |
| `GET /conversations/{id}` | The full record incl. `body` (the history array). |
| `PUT /conversations/{id}` | Upsert (see below). |
| `PUT /conversations/{id}/title` | **Rename** (see below). |
| `DELETE /conversations/{id}` | Idempotent — `200 {"ok": true}` even if absent or not the user's. |
| `GET /health` | `{"status": "ok"}` — no auth, not proxied publicly (used by the container healthcheck). |

List response:

```json
{ "conversations": [
    { "id": "c-…", "title": "…", "persona_key": "assistant",
      "created_at": "2026-08-30T…Z", "updated_at": "2026-08-30T…Z", "message_count": 8 }
  ],
  "total": 12, "cap": 100 }
```

The server returns newest-first, but **the UI does not rely on it**: it groups by persona (groups
A→Z by display name, "Unassigned" last) and sorts each group by last-modified, newest first.

### `PUT /conversations/{id}` — upsert (auto-save)

```json
{ "title": "string, ≤ 200 chars", "persona_key": "a persona key, or ''",
  "message_count": 0, "body": [ /* history array */ ] }
```

- Unknown top-level keys → `422`. `message_count` must be a non-negative integer. `persona_key` must be empty or one of the service's allowlist (the current persona keys **plus** the since-removed `claudePromptCompressor`, so old threads keep loading) — an image built before a persona existed rejects it with `422`.
- A serialized `body` over **1 MiB** → `413`.
- `created_at` is set on insert; `updated_at` (server clock, ISO-8601 `Z`) on every write.
- Inserting past `CONVERSATIONS_MAX_PER_USER` (default 100) **evicts the oldest by `updated_at`** until at the cap, so a PUT never fails for being at the cap.
- **A user-chosen title is preserved:** if the row was renamed (`title_custom = 1`), the title in the PUT body is ignored and the stored one kept; otherwise it is replaced (the client derives an automatic title from the first user message each turn).
- → `200 {"ok": true, "id", "created_at", "updated_at"}`.

### `PUT /conversations/{id}/title` — rename

```json
{ "title": "string" }
```

Only `title` is accepted (any other key → `422`). The value is trimmed, ASCII control characters are replaced and whitespace collapsed; the result must be non-empty and ≤ 200 characters (`422` otherwise). It sets `title_custom = 1`. **Only the title changes** — `persona_key` (the group) and `updated_at` (list position) are untouched. Unknown / another user's id → `404`; it never creates a row. → `200 {"ok": true, "id", "title"}`.

It is a `PUT` sub-resource rather than `PATCH` so nginx's existing `limit_except GET PUT DELETE` blocks needed no change.

### IDs

The **client** generates the id (`'c-' + <base-36 timestamp> + '-' + <random>`) so it can `PUT` from the first turn. The server treats it opaquely and only validates `^[A-Za-z0-9_-]{1,64}$`.

---

## Storage

One table, `conversations(id PK, username, title, persona_key, created_at, updated_at, message_count, body, title_custom)`, index on `(username, updated_at)`. `body` is the JSON history. `title_custom INTEGER NOT NULL DEFAULT 0` was added in v1.35.0; `_init_db()` adds it to an existing volume with `ALTER TABLE … DEFAULT 0`, so upgrading keeps every row and leaves existing titles automatic.

## Configuration

| Variable | Fallback |
|---|---|
| `CONVERSATIONS_DB_PATH` | `/data/conversations.db` |
| `CONVERSATIONS_MAX_PER_USER` | `100` |

## Service / infra

- Directory `conversations-service/`, container `vpal-conversations`, listens on `:8006` (Docker-internal), image runs as uid 65532 with a read-only root FS.
- SQLite lives on the **named volume** `vpal-conversations-data` (not tmpfs). The Dockerfile seeds `/data` owned by uid 65532 so the non-root process can create the database and its `-wal`/`-shm` files.
- nginx: `location = /conversations` and `location ^~ /conversations/` — both `auth_request /auth/verify`, forward `X-Auth-User`, allow `GET PUT DELETE` only, sit on the `conversations` zone (**60 req/min, burst 20** — a write follows every completed turn) and raise `client_max_body_size` to `2m`. Template placeholder `${CONVERSATIONS_UPSTREAM}` (default `conversations-service:8006`) is the **10th** placeholder in `nginx.conf.template`.
- **Deploy gotchas:** the service runs from a *built image* (rebuild after pulling — `--force-recreate` alone keeps old code), and nginx must be recreated or reloaded after the container is recreated (it resolves backends once at startup). See the README's *Keeping the stack up to date*.

## Resilience

Any `/conversations` failure logs to the console. User-initiated actions (open, delete, search, rename) show a toast on failure; auto-save failures are silent and retried on the next turn — with one exception: a **`422` on auto-save** means the image is older than the frontend (it doesn't know the active persona), so history would silently never be saved; the UI shows a one-time *"Chat history isn't being saved — the conversations service is out of date. Rebuild it…"* toast. Chat itself never blocks on the history service.

## Verification (manual, needs a TOTP login)

Send a few turns and confirm they appear in the sidebar under the right persona; search by title and by message text; open an old chat (its persona is restored); rename one (it stays put, survives the next turn); delete one; push past the cap and watch the oldest evict; recreate `conversations-service` and confirm persistence; round-trip a Settings export/import.
