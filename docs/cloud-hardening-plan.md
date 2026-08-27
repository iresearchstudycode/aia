# VPAL Cloud-Hardening Plan

**Status:** Draft for decision — analysis only, no code changed in this branch.
**Scope:** What must change before VPAL (`dev` branch) can be exposed on the public internet on any cloud platform.
**Deployment model (fixed by the operator, not re-litigated here):**

- **Platform-agnostic.** No AWS/GCP/Azure specifics. Every requirement is expressed as an env var plus a provider-neutral capability the operator satisfies however their platform does (TLS termination, secret injection, private networking).
- **Ollama and VoiceBox stay external host services**, reached over the network, parametrized by env var (replacing `host.docker.internal` / `extra_hosts`).
- **No authentication will be added in front of VoiceBox.** The residual risk is called out prominently (Finding J) and the plan mandates compensating network controls instead.

> There is currently **no "Branching & Release Workflow" section in `CLAUDE.md`** despite it being referenced as context. CI (`.github/workflows/ci.yml`) triggers only on `master` (`push`/`pull_request` → `branches: [master]`), so a PR into `dev` runs **no CI at all**. Both are noted in Finding M / the sequence section.

---

## 1. Executive summary

VPAL is a well-built *local* application. Its baseline is genuinely strong for a self-hosted single-user tool: TOTP auth with per-username lockout and TOTP-replay protection (`auth/main.py`), an Nginx `auth_request` gate in front of **every** application route (`deploy/nginx/nginx.conf`), exact-match proxy locations that deny every method/path the browser does not need, digest-pinned distroless containers running non-root (uid 65532) with `read_only`, `cap_drop: ALL`, `no-new-privileges` and per-service CPU/memory/pids limits (`docker-compose.yml`), SRI-pinned vendored JS, a strict `script-src 'self'` CSP, stateless signed-cookie sessions, and no server-side persistence of chat history, uploaded files, or synthesized audio.

That posture was designed for `127.0.0.1`, 1–5 users, self-signed certs, and in-process state. Cloud exposure breaks five load-bearing assumptions: (1) the process never restarts and is never replicated, so in-memory lockout/replay state is authoritative; (2) the client IP Nginx sees is the real client; (3) TLS is terminated by this Nginx with a known local cert; (4) upstreams are always `host.docker.internal`; (5) `.env` on disk is an acceptable secret store. Each must be fixed before the app is reachable from the internet.

**Top 5 blockers (all P0):**

1. **B — In-memory auth state.** Brute-force counters and the TOTP-replay cache live in process memory (`auth/main.py:61`, `:89`). A restart (deploy, crash, autoscale) resets them inside the 90 s TOTP window; with >1 replica the state is per-replica, so an attacker gets N× the lockout budget and TOTP replay protection fails outright. Needs a shared store (Redis).
2. **C — Secret blast radius.** `docker-compose.yml` hands the **entire** secret set (`SECRET_KEY`, all `USER_*`, all `TOTP_SECRET_*`, `SETUP_TOKEN`) to all three services via `env_file: .env`, but only `auth` reads any secret. A leak in `doc-extract` (parses untrusted PDFs) or `voicebox-proxy` (makes outbound calls) exposes every user's TOTP seed and the session signing key. Needs per-service least-privilege secret injection from a real secret manager, never a committed/baked file.
3. **D — Forwarded headers behind a proxy/LB.** All rate-limit zones and access logs key on `$binary_remote_addr` (`nginx.conf:29–42`). Behind a TLS-terminating load balancer every request carries the LB's IP, collapsing all limits into one shared bucket and blinding the logs — unless `real_ip` is configured to trust *only* the LB's CIDR. The HTTP→HTTPS redirect (`nginx.conf:69`) also ignores `X-Forwarded-Proto`, causing redirect loops behind an offloading LB.
4. **E — Hardcoded host networking.** `proxy_pass http://host.docker.internal:11434/api/chat` is a literal (`nginx.conf:211`); Nginx does not interpolate env vars, and the `cgr.dev/chainguard/nginx` image is distroless with no shell and no `envsubst`, so the usual template trick is unavailable. Every upstream, `server_name`, cert path, and the `listen` directive must become deploy-time-rendered.
5. **F — TLS.** Self-signed mkcert certs with hardcoded paths and `listen 443 ssl` as the only mode (`nginx.conf:74,93–94`). Cloud needs a real cert via one of three provider-neutral paths (LB terminates / ACME / mounted from secret store) and the config must support "Nginx serves plaintext on a private port."

Plus **N** — there is no deployment runbook, required-env-var table, or "do not deploy if…" gate today.

---

## 2. Current security posture (the baseline to preserve)

| Area | What is already done well | Evidence |
|---|---|---|
| Auth gate | `auth_request /auth/verify` on `location /`, `= /ollama/api/chat`, `= /voicebox/speak`, `^~ /voicebox/audio/`, `= /doc-extract/extract`. `/auth/verify` is `internal`. | `nginx.conf:111,185,198,232,257,281` |
| Proxy minimization | Exact-match / narrow-prefix locations; `limit_except` denies every method the route doesn't use; other Ollama paths (`/api/tags`, `/api/pull`) unreachable. | `nginx.conf:187–190,201,235,260,284` |
| TOTP | RFC 6238 via `pyotp`, `valid_window=1`; dummy verify on unknown username to equalize timing; replay cache rejects a re-used code inside 90 s. | `auth/main.py:329–343` |
| Brute force | Per-username sliding window, 5 attempts / 300 s. | `auth/main.py:58–70` |
| Session | `itsdangerous.TimestampSigner`, absolute TTL enforced on `unsign(max_age=…)`; cookie `HttpOnly`, `Secure`, `SameSite=Strict`. Stateless → horizontally scalable, no session store. | `auth/main.py:124–134,158–167` |
| CSRF | Double-submit; token is HMAC-SHA256(session, "…:csrf"), so it self-invalidates with the session; `hmac.compare_digest` comparisons. | `auth/main.py:111–121,360–373` |
| CSP | `script-src 'self'` — no `unsafe-inline`/`unsafe-eval`; `connect-src 'self'`; `form-action 'self'`; `img-src 'self' data:`. All handlers wired via `addEventListener`. | `nginx.conf:88` |
| Containers | Digest-pinned Chainguard distroless, multi-stage (no pip/shell at runtime), non-root uid 65532, `read_only: true`, `tmpfs` for the few writable paths, `cap_drop: ALL` (Nginx re-adds only `NET_BIND_SERVICE`), `no-new-privileges`, CPU/mem/pids limits on all four services. | `*/Dockerfile`, `docker-compose.yml:13–27,52–67,89–105,149–171` |
| Supply chain (frontend) | `marked`, `dompurify`, `katex`, `katex-auto-render`, `katex.min.css` all SRI-pinned; no external hosts referenced anywhere in `index.html`. | `src/aia/index.html:10–21` |
| Data at rest | Chat history is client-side only (saved to the user's disk as JSON, never POSTed anywhere except folded into the Ollama message). Uploaded PDFs parsed in memory, never written (`read_only` FS). VoiceBox generation cache is an in-memory `OrderedDict` capped at 200, cleared on restart. | `api.js:104–124`, `doc-extract/main.py:78–99`, `voicebox-proxy/main.py:72–91` |
| API surface | FastAPI `docs_url=None, redoc_url=None, openapi_url=None` on all three services; `server_tokens off` in Nginx. | `auth/main.py:266`, `voicebox-proxy/main.py:161`, `doc-extract/main.py:57`, `nginx.conf:16` |
| No permissive CORS | No `CORSMiddleware` anywhere; FastAPI emits no `Access-Control-Allow-Origin`. | grep: no matches |

**Preserve every one of these while making the changes below.** Several recommendations (real-cert TLS, secret manager, Redis) *add* moving parts; none should relax the controls above.

---

## 3. Threat model: local → cloud delta

| Dimension | Local (as designed) | Cloud (new reality) | Consequence for VPAL |
|---|---|---|---|
| Reachability | `127.0.0.1` only (`docker-compose.yml:142–143`) | Public DNS + internet-routable ingress | Continuous hostile automated traffic hits `/auth/login`, `/auth/setup`, `/ollama/api/chat` |
| Process lifetime | Long-lived, manually restarted | Restarts on every deploy, crash, node drain, scale event | In-memory lockout/replay windows reset (Finding B) |
| Replication | Exactly 1 instance | 0..N replicas behind an LB | Per-replica auth state → brute-force budget multiplies, TOTP replay defeated (Finding B) |
| Client identity | `$remote_addr` == real user | `$remote_addr` == load balancer | Rate limits become one global bucket; logs lose attacker IP (Finding D) |
| TLS | Nginx terminates, mkcert self-signed | LB or ACME terminates; real CA cert; HSTS actually enforced by browsers | Cert lifecycle, `X-Forwarded-Proto`, plaintext-backend mode (Findings F, D) |
| Upstreams | `host.docker.internal` gateway | Ollama/VoiceBox on private IPs or service DNS, reachable only over a private network | `proxy_pass` and `VOICEBOX_URL` must be env-driven; VoiceBox must be network-fenced (Findings E, J) |
| Secrets | `.env` file on a trusted workstation | Filesystem is hostile; images are pullable; env vars visible in platform consoles | Secret manager + least privilege + rotation (Finding C) |
| Blast radius of one bug | One user's laptop | Every user's TOTP seed, the signing key, the host network | Least-privilege secret scoping, network segmentation (Findings C, J) |
| Observability | `docker logs`, a human watching | Nobody watching; need alerting | Structured logs, auth-event stream, failed-auth alerting (Finding K) |
| Setup endpoint | Briefly enabled on localhost | `GET /auth/setup?token=…` renders **plaintext TOTP secrets** to anyone with the token, over the internet | Must be provably disabled in prod (Finding C) |

---

## 4. Prioritized findings

| ID | Title | Priority | Affected files | Effort |
|---|---|---|---|---|
| B | Auth lockout + TOTP-replay state is in-process (not shared, not persistent) | **P0** | `auth/main.py:58–103`; `auth/tests/conftest.py` | M |
| C | Full secret set injected into all 3 services; plaintext `.env`; `SETUP_TOKEN` not fenced | **P0** | `docker-compose.yml:10,46,87`; `auth/main.py:28–51`; `voicebox-proxy/main.py:44–48`; `doc-extract/main.py:23–27`; `.env.example` | M |
| D | Rate limits & logs key on `$binary_remote_addr`; no `real_ip`; redirect/HSTS ignore `X-Forwarded-Proto` | **P0** | `deploy/nginx/nginx.conf:19,29–42,66–70` | S |
| E | Hardcoded upstreams / `host.docker.internal`; Nginx can't template `proxy_pass`; distroless has no `envsubst` | **P0** | `deploy/nginx/nginx.conf:48–63,211`; `docker-compose.yml:50–51,146–147` | L |
| F | Self-signed certs, hardcoded paths, `listen 443 ssl`-only, no plaintext-backend mode | **P0** | `deploy/nginx/nginx.conf:74,93–94,97–101`; `docker-compose.yml:180–184` | M |
| N | No deployment runbook, env-var contract, pre-flight checklist, or "do not deploy if…" gates | **P0** | *(new)* `docs/` | M |
| G | Session/CSRF cookie hardening: no name prefix, no idle expiry, no server-side revocation | P1 | `auth/main.py:124–155,375–379` | S |
| H | No `TrustedHostMiddleware` / allowed-hosts; no `Origin`/`Referer` check on state-changing routes; `$host` reflected in redirect | P1 | `auth/main.py:266,308–346`; `nginx.conf:66–70,88` | M |
| I | Prod CSP/header gaps: no `frame-ancestors`, `base-uri`, `object-src`, `upgrade-insecure-requests`, COOP/CORP | P1 | `deploy/nginx/nginx.conf:78–90` | S |
| J | `doc-extract` / `voicebox-proxy` public exposure: no per-request timeout for hostile PDFs; **VoiceBox has no auth of its own** | P1 | `doc-extract/main.py:34–99`; `voicebox-proxy/main.py:44,103–155`; `nginx.conf:231–298`; `docker-compose.yml:98–105` | M |
| K | Logging & monitoring: `auth` logs nothing; no auth-event stream; no readiness probe; health endpoints not proxied | P1 | `auth/main.py` (no `logging` import); `voicebox-proxy/main.py:38,175,199`; `doc-extract/main.py:17,44`; `docker-compose.yml:32–38`; `nginx.conf` | M |
| L | Distributed credential-stuffing defeats per-IP limits; account-lockout-as-DoS tradeoff | P2 | `auth/main.py:58–78,315–346` | M |
| M | Supply chain / image ops: unpinned+untagged Nginx image; deps pinned but not hash-locked; no SBOM/signing; dev `docker-compose` used as prod descriptor; CI never runs on `dev` | P2 | `docker-compose.yml:120`; `*/requirements.txt`; `.github/workflows/ci.yml:4–7`; `*/.dockerignore` | M |
| P | Data-at-rest exposure (confirm & keep minimal) | P2 | `api.js`; `doc-extract/main.py`; `voicebox-proxy/main.py` | S |
| O | Out-of-scope / accepted risks (record decisions) | — | — | — |

Effort: **S** ≈ ≤1 day, config/small code · **M** ≈ 2–5 days · **L** ≈ >1 week or cross-cutting.

---

## 5. Detailed findings

### B — Auth lockout + TOTP-replay state is in-process

**Current state.**
`auth/main.py:61` `_failed_attempts: dict[str, list[float]]` and `auth/main.py:89` `_used_totp_codes: dict[tuple[str, str], float]` are module-level dicts. `_is_locked` (`:64`), `_record_failure` (`:73`), `_is_code_replay` (`:92`), `_mark_code_used` (`:102`) read/write them with no locking and no persistence. `auth/tests/conftest.py` clears both between tests, confirming they are the entire state. Timestamps use `time.monotonic()` — which resets on process start, so even the timestamps are not portable across a restart.

**Risk in cloud.**
- *Restart resets the window.* A deploy, OOM kill, health-check failure, or node recycle wipes `_failed_attempts` mid-attack. Because the TOTP code stays valid for ~90 s (`valid_window=1`), an attacker who has hit the 5-attempt lock just triggers a restart (or waits for a routine deploy) and resumes against the *same* still-valid code.
- *Replicas fragment the state.* With 2+ replicas behind an LB, each holds its own dicts. Lockout budget becomes `5 × replica_count`. TOTP replay protection is fully defeated: a code accepted on replica A is unknown to replica B, so a captured code (shoulder-surf, phishing proxy, malware) can be replayed on another replica within its validity window. This is also a **correctness** bug independent of security — a user load-balanced to a fresh replica sees inconsistent lockout behavior.

**Recommendation (provider-neutral).**
Introduce a shared store abstraction behind an env var, `AUTH_STATE_BACKEND` = `memory` (default, single-replica/dev) | `redis`.

- **Redis** (`REDIS_URL`, e.g. `redis://…` or `rediss://…` with TLS; support `REDIS_PASSWORD` / ACL user via the URL or a separate secret). Keys and semantics:

  | Purpose | Key | Type / op | TTL | Atomicity |
  |---|---|---|---|---|
  | Failed-attempt window | `vpal:bf:{username}` | `ZADD` score=now member=uuid, then `ZREMRANGEBYSCORE 0 (now-300)`, then `ZCARD` | `EXPIRE 300` after each write | Wrap the ZADD/ZREM/ZCARD in a Lua script or `MULTI` so the count is consistent |
  | Lockout check | same key | `ZCARD ≥ 5` → locked | — | single op |
  | Clear on success | `DEL vpal:bf:{username}` | `DEL` | — | single op |
  | TOTP replay guard | `vpal:totp:{username}:{code}` | `SET … value=1 NX EX 90` | 90 s (`_REPLAY_WINDOW_SECONDS`) | `SET NX EX` is atomic — if it returns nil, the code is a replay. This replaces the *check-then-mark* race in the current code. |

  Use `time.time()` (wall clock) for scores, not `monotonic`, so entries survive a restart and are comparable across replicas. Redis must run on the private network only, require auth, and ideally use TLS (`rediss://`).

- **SQLite** is acceptable **only if single-replica is contractually enforced** (`replicas: 1` in the deployment descriptor, documented, and asserted at startup — see below). It buys persistence-across-restart but not cross-replica correctness. A WAL-mode SQLite file on a small persistent volume, one table `failed_attempts(username, ts)` and one `used_totp(username, code, ts)`, pruned on read. If the platform cannot guarantee exactly one replica, do not use SQLite.

- **Fail-closed on store outage.** If the backend is unreachable during a login attempt, treat the account as **locked** (return the existing generic `_ERROR_MSG`, 401) and log a `store_unavailable` event. Rationale: failing open re-opens unlimited brute force and unlimited TOTP replay — worse than a brief login outage for a 1–5-user tool. `/auth/verify` (session validation) does **not** touch the store, so existing sessions are unaffected by a store outage; only new logins are blocked.

- **Migration path.** Ship the abstraction with `memory` as default so nothing changes for local use. Cloud deployments set `AUTH_STATE_BACKEND=redis` + `REDIS_URL`. Add a startup assertion: if `AUTH_STATE_BACKEND=memory` **and** an env var like `EXPECTED_REPLICAS` > 1 (or a generic `DEPLOY_ENV=cloud`), refuse to start. Update `auth/tests/conftest.py` and add a `fakeredis`-backed test path.

**Effort.** M (new module + Redis client dep + tests + compose/descriptor wiring).

**Acceptance criteria.**
- With 3 replicas and `AUTH_STATE_BACKEND=redis`, 5 total bad attempts across *any mix of replicas* locks the account; a 6th is refused by every replica.
- A TOTP code accepted once is refused by every replica for 90 s.
- Restarting all replicas does not reset an in-progress lockout.
- Redis made unreachable → login attempts fail closed with a generic error and an audit log line; `/auth/verify` for existing sessions still returns 200.
- `AUTH_STATE_BACKEND=memory` default path is unchanged; local `docker-compose up` needs no Redis.

---

### C — Secret blast radius: full secret set to every service; plaintext `.env`; `SETUP_TOKEN`

**Current state.**
`docker-compose.yml` sets `env_file: .env` on **all three** Python services (`:10`, `:46`, `:87`). `.env` (per `.env.example`) contains `SECRET_KEY`, `SESSION_TTL_HOURS`, `SETUP_TOKEN`, and `USER_1..5` / `TOTP_SECRET_1..5`. Actual env reads per service:

| Service | Env vars actually read | Secret? | Source |
|---|---|---|---|
| `auth` | `SECRET_KEY` (required), `SESSION_TTL_HOURS`, `SETUP_TOKEN`, `USER_1..5`, `TOTP_SECRET_1..5` | **Yes — all of it** | `auth/main.py:28–30,47–48` |
| `voicebox-proxy` | `VOICEBOX_URL`, `VOICEBOX_CLIENT_ID`, `VOICEBOX_TIMEOUT_SECONDS` | No | `voicebox-proxy/main.py:44–48` |
| `doc-extract` | `MAX_UPLOAD_BYTES`, `MAX_TEXT_CHARS` | No | `doc-extract/main.py:23,27` |

So `voicebox-proxy` and `doc-extract` are handed every user's TOTP seed and the session signing key **for nothing**. `.dockerignore` (all three, identical) correctly excludes `.env` from the *build context*, and `.gitignore` keeps `.env` and `deploy/certs/` untracked (`git ls-files` confirms only `.env.example` is tracked) — but at **runtime** the full secret set is in the environment of two services that (a) parse attacker-supplied PDF bytes (`pypdf`, historically a source of parser CVEs) and (b) make outbound HTTP to a host service. Either is a more attractive RCE/SSRF target than `auth`, and either compromise now yields every credential.

`SECRET_KEY` has no rotation story: `TimestampSigner(_SECRET_KEY)` (`auth/main.py:33`) takes a single string. Rotating it invalidates **every** session and every `vpal_csrf` token at once.

`SETUP_TOKEN`: `GET /auth/setup` (`auth/main.py:382–397`) renders each user's **plaintext base32 TOTP secret and provisioning URI** into HTML whenever `SETUP_TOKEN` is set and matches. It sits under `location ^~ /auth/` with **no `auth_request`** (`nginx.conf:160`), i.e. reachable unauthenticated from the internet. The only gate is knowing the token.

**Risk in cloud.**
- One parser/SSRF bug in `doc-extract`/`voicebox-proxy` = full account takeover of all users + ability to forge sessions for anyone (`SECRET_KEY`).
- A `.env` baked into an image layer, committed by mistake, or printed by a debug endpoint is now internet-exposed.
- If `SETUP_TOKEN` is left in the prod environment, `GET /auth/setup?token=…` is a plaintext TOTP-seed disclosure endpoint. Tokens leak (browser history, proxy logs, screenshots).
- A forced `SECRET_KEY` rotation (suspected compromise) logs every user out with no graceful window.

**Recommendation (provider-neutral).**

1. **Per-service least privilege.** Split secret injection so each service receives only what it reads:
   - `auth`: `SECRET_KEY`, `SESSION_TTL_HOURS`, `SETUP_TOKEN` (prod: unset), `USER_*`, `TOTP_SECRET_*`, plus `REDIS_URL`/`REDIS_PASSWORD` from Finding B.
   - `voicebox-proxy`: `VOICEBOX_URL`, `VOICEBOX_CLIENT_ID`, `VOICEBOX_TIMEOUT_SECONDS` — **non-secret config only**.
   - `doc-extract`: `MAX_UPLOAD_BYTES`, `MAX_TEXT_CHARS` — **non-secret config only**.
   Remove the blanket `env_file: .env` from `voicebox-proxy` and `doc-extract`; give them an explicit non-secret `environment:` block (or their own tiny env file).
2. **Externalized secret injection.** The operator's platform supplies `auth`'s secrets as runtime environment (or files mounted at a path referenced by `SECRET_KEY_FILE`-style vars) from the platform secret manager / Docker secrets / equivalent. Requirements, provider-neutral:
   - Secrets are never in the image, the git repo, the build context, or a plaintext file on a shared/persistent volume.
   - Secret values are not echoed by any endpoint or log line (see Finding K).
   - Optionally support a `_FILE` convention (`SECRET_KEY_FILE=/run/secrets/secret_key`) so file-based secret stores work without a shell.
3. **`SECRET_KEY` rotation.** Accept `SECRET_KEY` (current) plus optional `SECRET_KEY_FALLBACKS` (comma-separated, previous keys). Verify sessions/CSRF against current then fallbacks; always **sign** with current. This gives a rotation window: deploy with old key as fallback, wait out `SESSION_TTL_HOURS`, drop the fallback. Document that emergency rotation *without* a fallback is a full logout and is the correct response to a confirmed key compromise.
4. **`SETUP_TOKEN` in prod.** Make it a hard gate: if `DEPLOY_ENV=cloud` (or similar) **and** `SETUP_TOKEN` is set, refuse to start — or at minimum, in prod, require `/auth/setup` to additionally be behind `auth_request` and an IP allowlist. Simplest and recommended: **prod runbook mandates `SETUP_TOKEN` unset**, initial enrolment done via a one-off `auth` task/exec on the private network, and CI/pre-flight checks that it is empty. Also add `location = /auth/setup { ... }` returning 404 in the prod Nginx template unless an explicit `ENABLE_SETUP` build arg is set.

**Effort.** M.

**Acceptance criteria.**
- `docker inspect` (or platform equivalent) of the running `voicebox-proxy` and `doc-extract` shows **no** `SECRET_KEY` / `TOTP_SECRET_*` / `USER_*` / `SETUP_TOKEN` in their environment.
- No secret appears in any image layer (`docker history`, layer scan) or in logs.
- `auth` starts with `SECRET_KEY` + one `SECRET_KEY_FALLBACKS` entry; sessions signed with the old key still validate; new sessions use the new key.
- In a prod-profile deploy, `SETUP_TOKEN` set → startup fails (or `/auth/setup` returns 404); pre-flight check asserts it is unset.

---

### D — Forwarded headers behind a proxy / load balancer

**Current state.**
- `limit_req_zone $binary_remote_addr zone=ollama_chat` / `auth_api` / `voicebox_speak` / `doc_extract` (`nginx.conf:29,34,39,42`). All per-client throttling keys on the TCP peer address.
- `access_log /dev/stdout` (`nginx.conf:19`) with the default `combined` format → `$remote_addr`.
- HTTP server: `listen 80; return 301 https://$host$request_uri;` (`nginx.conf:66–70`) — unconditional, based on the listener not on `X-Forwarded-Proto`.
- HSTS `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;` is emitted from the `listen 443 ssl` server only (`nginx.conf:78`).
- No `set_real_ip_from` / `real_ip_header` anywhere.
- Upstream `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` is set on the `/auth/*` and proxy locations (`nginx.conf:133,151,166,215,245,270,296`). No backend currently consumes it (`uvicorn` is not started with `--proxy-headers`), but that is a latent trap.

**Risk in cloud.**
- Behind a TLS-terminating LB, every request's peer address is the LB. All four rate-limit zones become a **single global bucket** — one abusive client exhausts the limit for everyone, and a distributed attack is not rate-limited per-source at all.
- Access logs record the LB IP for every line → no source attribution, no ability to block or investigate an attacker, no useful input to a WAF/fail2ban-style control.
- If `real_ip` is later added but trusts too broad a range (or `X-Forwarded-For` from *any* source), an attacker spoofs `X-Forwarded-For` to (a) evade the per-IP limit by rotating fake IPs, (b) poison logs, (c) bypass any future IP allowlist.
- Redirect loop: an offloading LB forwards HTTPS traffic to Nginx on port 80; `return 301 https://…` sends the browser back to the LB, which forwards to port 80 again → loop. Or, if the LB forwards on 443 to Nginx-with-TLS, double TLS.
- HSTS may not be emitted on the response the browser actually sees if the LB serves the redirect, or may be emitted with the wrong lifetime expectations.

**Recommendation (provider-neutral).**
- Add, in the rendered Nginx config, `set_real_ip_from <LB_CIDR>;` (repeatable, **operator-supplied, never `0.0.0.0/0`**) and `real_ip_header X-Forwarded-For;` + `real_ip_recursive on;`. Make the CIDR list an env-driven template value (Finding E). Document: if the platform's LB IPs are not a stable known range, use the platform's documented forwarded-header mechanism / a dedicated header the LB sets and strips, and trust only that.
- Rate-limit zones then key on the corrected `$binary_remote_addr` automatically.
- Scheme-aware redirect: gate the HTTP→HTTPS redirect on `$http_x_forwarded_proto` when present, e.g. redirect only when `$http_x_forwarded_proto != "https"`, and support a `TLS_MODE` template switch: `edge` (LB terminates — Nginx `listen <PORT>;` plaintext on a private port, no `ssl`, trust `X-Forwarded-Proto`, still emit HSTS) vs `terminate` (Nginx holds the cert — current behavior).
- Emit HSTS from whichever server block serves real user traffic in the chosen `TLS_MODE`.
- Keep `X-Forwarded-For` / `X-Forwarded-Proto` set to backends, but only start `uvicorn` with `--proxy-headers --forwarded-allow-ips=<nginx/pod CIDR>` if a backend needs the real IP (Finding K logging) — never with `--forwarded-allow-ips='*'`.

**Effort.** S (config/template only).

**Acceptance criteria.**
- Behind the LB, `access_log` shows distinct real client IPs; two different clients get independent rate-limit budgets; the same client hitting `/auth/login` 6×/min gets 429.
- A request with a forged `X-Forwarded-For: 1.2.3.4` from outside the trusted CIDR does **not** change the rate-limit bucket or the logged IP.
- `TLS_MODE=edge`: plain HTTP from the LB is served without redirect loop; HSTS header present; `https://` still enforced end-to-end.
- `TLS_MODE=terminate`: unchanged from today.

---

### E — Hardcoded host networking; Nginx cannot template `proxy_pass`

**Current state.**
- `nginx.conf:211` `proxy_pass http://host.docker.internal:11434/api/chat;` — literal host, port, path.
- `nginx.conf:48–63` upstreams `auth:9000`, `voicebox-proxy:8002`, `doc-extract:8003` — literal Docker-compose service names.
- `nginx.conf:68,76` `server_name localhost;`
- `docker-compose.yml:50–51,146–147` `extra_hosts: - "host.docker.internal:host-gateway"` on `nginx` and `voicebox-proxy`.
- `voicebox-proxy/main.py:44` default `VOICEBOX_URL=http://host.docker.internal:17493` (already env-overridable — good).
- The image is `cgr.dev/chainguard/nginx` (`docker-compose.yml:120`): distroless, **no shell**, **no `envsubst`**, healthcheck is `nginx -t` precisely because there is no HTTP client. The official-nginx `/docker-entrypoint.d/20-envsubst-on-templates.sh` pattern is **not available** here.

**Risk in cloud.**
- The Ollama upstream cannot be pointed at a private Ollama host without editing tracked config — there is no supported runtime parametrization.
- `host.docker.internal` / `host-gateway` do not exist on most cloud container runtimes; `voicebox-proxy` and the Ollama proxy silently fail to resolve.
- `server_name localhost` + no default-server rejection means the config does not distinguish the real hostname (feeds Finding H).

**Recommendation (provider-neutral).** Pick one:

1. **Deploy-time render (recommended).** Keep `deploy/nginx/nginx.conf.template` in the repo with `${VAR}` placeholders; render it to `nginx.conf` in CI/CD or an **init container** (any image with `envsubst`/`sed`) that writes to a shared volume the distroless Nginx then mounts read-only. No change to the runtime image.
2. **Switch the runtime image** to `nginx:1.27-alpine` (already used in CI's `nginx-config-check`), which ships `envsubst` and the template entrypoint. Trade-off: lose Chainguard's distroless/CVE posture; would need to re-add non-root, `read_only`, etc. Not recommended given the current hardening.
3. **`njs`/Lua** for dynamic upstreams — over-engineered for this; adds a module dependency.

Template values that must become env-driven:

| Placeholder | Replaces | Example |
|---|---|---|
| `${OLLAMA_UPSTREAM}` | `host.docker.internal:11434` in `proxy_pass` (`:211`) | `ollama.internal:11434` |
| `${AUTH_UPSTREAM}` | `auth:9000` (`:49`) | `vpal-auth.internal:9000` |
| `${VOICEBOX_PROXY_UPSTREAM}` | `voicebox-proxy:8002` (`:55`) | `vpal-voicebox-proxy.internal:8002` |
| `${DOC_EXTRACT_UPSTREAM}` | `doc-extract:8003` (`:61`) | `vpal-doc-extract.internal:8003` |
| `${SERVER_NAME}` | `localhost` (`:68,76`) | `vpal.example.com` |
| `${TLS_MODE}` / `${LISTEN_DIRECTIVE}` | `listen 443 ssl` vs plaintext (`:74`) | see Finding F |
| `${SSL_CERT_PATH}` / `${SSL_KEY_PATH}` | `/etc/nginx/ssl/localhost*.pem` (`:93–94`) | see Finding F |
| `${REAL_IP_FROM}` | *(new)* `set_real_ip_from` CIDRs | see Finding D |
| `${HSTS_MAX_AGE}` | `31536000` (`:78`) | keep or tune |
| `${RESOLVER}` | *(new)* `resolver <platform DNS>;` needed if upstreams are DNS names re-resolved at runtime | `resolver 169.254.x.x valid=30s;` |
| Rate-limit rates (`:29,34,39,42`) | optional — expose as vars if per-env tuning is wanted | — |

Also: `voicebox-proxy/main.py` already reads `VOICEBOX_URL`; just set it in the environment and drop `extra_hosts`. Nothing in `doc-extract` needs this (it is self-contained — confirmed, no `host.docker.internal`).

**Effort.** L (template + render pipeline/init container + CI update + docs; touches deploy topology).

**Acceptance criteria.**
- No literal `host.docker.internal`, service name, `localhost`, or cert path remains in the rendered-from-template runtime config; all come from env.
- `nginx -t` passes on the rendered config in CI (extend `nginx-config-check` to render first).
- The distroless runtime image is unchanged (option 1) or the security posture is fully re-established (option 2).
- Pointing `${OLLAMA_UPSTREAM}` at an arbitrary host:port works with no image rebuild.

---

### F — TLS

**Current state.**
`nginx.conf:74` `listen 443 ssl;` (only mode). `:93–94` `ssl_certificate /etc/nginx/ssl/localhost.pem; ssl_certificate_key /etc/nginx/ssl/localhost-key.pem;` — bind-mounted from `deploy/certs/` (`docker-compose.yml:180–184`), generated by mkcert (self-signed, `localhost`). `:97–101` TLS 1.2/1.3, `ssl_ciphers HIGH:!aNULL:!MD5`, `ssl_prefer_server_ciphers on`, `ssl_session_cache shared:SSL:10m`. No OCSP stapling, no `ssl_session_tickets off`. HSTS `max-age=31536000; includeSubDomains` (no `preload`).

**Risk in cloud.**
- A self-signed `localhost` cert fails validation for every real client; users would be trained to click through cert warnings (or it simply won't load with HSTS).
- Hardcoded paths + single mode prevent the three standard cloud TLS topologies.
- `includeSubDomains` on a real domain commits **every** subdomain of `${SERVER_NAME}`'s parent to HTTPS for a year — fine if VPAL owns its own hostname, a problem if it is `app.corp.example.com` and other `*.example.com` services are not HTTPS-ready. `preload` is effectively irreversible (removal from the browser preload list takes months).

**Recommendation (provider-neutral).** Support all three via the `${TLS_MODE}` template switch from Finding E:

| Mode | Nginx role | Cert source | Notes |
|---|---|---|---|
| `edge` | Plaintext on a private port; LB terminates TLS | Platform LB / managed cert | Nginx trusts `X-Forwarded-Proto` (Finding D), still emits HSTS. **Simplest; recommended default for cloud.** |
| `acme` | Nginx terminates; cert auto-renewed | ACME client (sidecar/companion writing to a shared volume, or a cron job) | Needs port 80 reachable for HTTP-01, or DNS-01. `${SSL_CERT_PATH}` points at the ACME output dir. |
| `mounted` | Nginx terminates | Cert + key delivered from the secret store to a mount path | `${SSL_CERT_PATH}`/`${SSL_KEY_PATH}` env-driven. Operator owns renewal. |

- Parametrize `${SSL_CERT_PATH}` / `${SSL_KEY_PATH}`; remove the `deploy/certs` bind mount from the prod descriptor.
- HSTS: keep `max-age=31536000`. Keep `includeSubDomains` **only if** VPAL controls the whole domain; otherwise make it a template flag `${HSTS_INCLUDE_SUBDOMAINS}` defaulting off for cloud until confirmed. Do **not** add `preload` until: HSTS has run in prod for weeks with no HTTPS issues, `includeSubDomains` is on, every subdomain is HTTPS, and the team accepts it is a long-term commitment. Document `preload` as opt-in only.
- Add `ssl_session_tickets off;` (or a rotated ticket key) for forward secrecy; consider OCSP stapling (`ssl_stapling on;`) in `acme`/`mounted` modes; tighten `ssl_ciphers` to a modern list (e.g. Mozilla "intermediate") once real clients are known.
- Regenerate local mkcert certs stay as-is for `docker-compose` dev.

**Effort.** M.

**Acceptance criteria.**
- `TLS_MODE=edge` deploy: browser reaches VPAL over a valid public cert (LB's); Nginx receives plaintext on the private port; `https://` enforced; HSTS present.
- `TLS_MODE=mounted`/`acme`: Nginx serves a valid CA cert from the env-driven path; renewal path documented and tested.
- No `deploy/certs` mount in the prod descriptor.
- HSTS `includeSubDomains` decision recorded; `preload` absent.
- SSL Labs / testssl.sh grade A on the chosen endpoint.

---

### N — Deployment runbook / prerequisites

**Current state.** `README.md` covers `docker-compose up` on localhost. There is no cloud runbook, no consolidated env-var contract, no pre-flight security checklist, no "do not deploy if…" gate.

**Risk in cloud.** Misconfiguration is the most likely failure mode — `SETUP_TOKEN` left on, `SECRET_KEY` too short or reused, rate-limit `real_ip` misconfigured, VoiceBox reachable publicly, Redis with no auth. Without an explicit gate these ship silently.

**Recommendation.** Produce and maintain the runbook in Section 6 of this document (env-var tables, secret generation, pre-flight checklist, hard gates). Wire the machine-checkable gates into CI/CD as a pre-deploy job.

**Effort.** M. **Acceptance:** Section 6 exists, is referenced from `README.md`, and its hard gates run as an automated pre-deploy check.

---

### G — Session / CSRF cookie hardening

**Current state.** `_set_session_cookie` (`auth/main.py:124–155`) sets `vpal_session` (`HttpOnly`, `Secure`, `SameSite=strict`, `max_age=_SESSION_TTL_SECONDS`), `vpal_csrf` (not HttpOnly — intentional, read by JS for the logout double-submit), `vpal_user` (not HttpOnly — display name only, "carries no authentication capability"). No `__Host-`/`__Secure-` name prefix, no explicit `path`, no `domain`. Session lifetime is **absolute** (`unsign(max_age=…)` at `:164`) — no sliding/idle expiry, no server-side revocation (stateless). `logout` (`:375–378`) deletes all three but omits `httponly=` on the `vpal_csrf`/`vpal_user` deletes (cosmetic).

**Risk in cloud.**
- `Secure` is already hardcoded `True` — good, keep it (do not make it conditional).
- Without `__Host-`, a subdomain or a MitM on a related host could set a `vpal_session` cookie that the app then trusts (cookie-fixation-ish); `__Host-` forbids `Domain`, forces `Path=/` and `Secure`.
- No revocation: a stolen session cookie is valid for the full `SESSION_TTL_HOURS` (default 8) with no way to kill it server-side. On the internet this window matters more.
- Absolute-only expiry is actually the *stronger* choice vs idle-only; the gap is that there is no *short* idle cap for shared/kiosk situations.

**Recommendation.**
- Rename `vpal_session` → `__Host-vpal_session` (and `vpal_csrf` → `__Host-vpal_csrf`). Keep `vpal_user` as-is or `__Secure-vpal_user` (it may want a readable name; low risk). One-time: existing sessions invalidated on deploy — acceptable, communicate it.
- Set `path="/"` explicitly (required for `__Host-`), no `domain`.
- Keep `SameSite=Strict` (correct for an internal tool; note the minor UX cost that a cross-site inbound link shows the login page on first hit).
- Add an **absolute + idle** model: keep the 8 h absolute cap; additionally re-issue the cookie on activity with a rolling shorter window (e.g. `SESSION_IDLE_MINUTES=60`), and store `iat`/`last_seen` in the signed payload. Refuse if `now - last_seen > idle` or `now - iat > absolute`.
- Optional server-side revocation: a `vpal:session:revoked:{jti}` set in the Redis from Finding B, checked in `/auth/verify`. Adds a Redis dependency to session validation — only do this if the threat model wants "log out all sessions" / "kill one session". Otherwise document that shortening `SESSION_TTL_HOURS` is the only revocation lever.
- Document explicitly which cookies are deliberately non-HttpOnly and why (`vpal_csrf` for the double-submit; `vpal_user` for the profile widget — no auth capability). That rationale stays valid.

**Effort.** S (M if adding revocation).

**Acceptance criteria.** Session cookie is `__Host-`-prefixed, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`. Idle timeout enforced. Non-HttpOnly cookies documented. `SECRET_KEY` fallback (Finding C) still validates old cookies during rotation.

---

### H — Host / Origin validation

**Current state.** No `TrustedHostMiddleware` (grep: no match). Nginx `server_name localhost` with **no default-server / no Host rejection**, so any `Host:` value is served; `$host` is used in the redirect `return 301 https://$host$request_uri` (`:69`) and passed upstream as `Host` (`:131,149,165,213,…`). CSRF is the HMAC double-submit on `/auth/logout` only. `/auth/login`, `/ollama/api/chat`, `/doc-extract/extract`, `/voicebox/speak` have **no** `Origin`/`Referer` check — they rely on `SameSite=Strict` on `vpal_session`.

**Risk in cloud.**
- Host-header injection: `$host` reflected into the redirect enables an open-redirect / cache-poisoning primitive against any shared cache; passing an attacker `Host` upstream can confuse absolute-URL generation.
- `SameSite=Strict` is a strong CSRF mitigation, but: (a) it is one layer; (b) `/doc-extract/extract` accepts `multipart/form-data`, a "simple" request that a cross-site form could submit if the cookie ever weakened; (c) `/ollama/api/chat` is JSON (non-simple, needs a preflight — safer).

**Recommendation.**
- **Nginx:** add a `server { listen …; server_name _; return 444; }` default block, and in the real server block keep `server_name ${SERVER_NAME}`. Use `$host` only after it has matched `server_name` (or switch the redirect to a literal `https://${SERVER_NAME}$request_uri`).
- **FastAPI:** add `TrustedHostMiddleware(allowed_hosts=[…from env…])` to all three apps (`auth`, `voicebox-proxy`, `doc-extract`) — cheap defense-in-depth even though they sit behind Nginx.
- **Origin/Referer check** on state-changing endpoints as a second CSRF layer on top of `SameSite` and (for logout) the existing double-submit: reject `POST /auth/login`, `POST /auth/logout`, `POST /ollama/api/chat`, `POST /doc-extract/extract`, `POST /voicebox/speak` when `Origin` (or `Referer` fallback) is present and not in the allowed-origins env list. Implement once as shared middleware or an Nginx `map` + `if` returning 403. For the Nginx-level version, gate the proxy `location`s on `$http_origin` against `${ALLOWED_ORIGIN}`.
- **Confirm CORS stays closed:** do not add `CORSMiddleware`. If ever added, `allow_origins` must be the explicit list, never `*`, and never with `allow_credentials=True` + `*`.

**Effort.** M.

**Acceptance criteria.** Request with `Host: evil.com` → 444/redirect to canonical host only, never reflects the attacker host. `POST /doc-extract/extract` with `Origin: https://evil.com` → 403. No `Access-Control-Allow-Origin` on any response. `TrustedHostMiddleware` rejects unknown hosts at each service.

---

### I — Security headers for production

**Current state (`nginx.conf:78–90`).** HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: geolocation=(), payment=(), usb=(), camera=(), microphone=(self)`, CSP = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self';`. Missing: `frame-ancestors`, `base-uri`, `object-src`, `upgrade-insecure-requests`, COOP/COEP/CORP.

**Risk in cloud.** `X-Frame-Options` is obsoleted by `frame-ancestors`; without it, framing protection depends on a header some proxies strip. No `base-uri` → a `<base>` injection (if any HTML-injection sink is ever found) can repoint every relative URL. No `object-src 'none'` → plugin-based bypass surface.

**Recommendation.** New CSP:
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; upgrade-insecure-requests;`
Add `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin` (both safe here — no cross-origin embedding). COEP: skip unless a future feature needs cross-origin isolation (it would need every subresource to send CORP). Keep `X-Frame-Options: DENY` for legacy clients.

**`style-src 'unsafe-inline'` (KaTeX) assessment.** KaTeX positions glyphs via hundreds of *distinct, content-dependent* inline `style` attributes generated at render time (`CLAUDE.md` "Security Invariants", TODO "Known Limitations"). Hashes (`'unsafe-hashes'` + `sha256-…`) are impractical (unbounded distinct values); nonces do not apply to style **attributes**. So this is an **accepted residual**, and it is well-bounded: `script-src` has no inline/eval, `default-src`/`connect-src` are `'self'`, `img-src` has no wildcard host — an injected inline style cannot exfiltrate or load anything external. **Keep the exception; do not pass KaTeX `trust: true`** (would re-enable `\href`/`\url`/`\includegraphics`/`\html*`). Re-review only if KaTeX is removed or a CSS-class-only KaTeX build appears.

**Effort.** S. **Acceptance:** securityheaders.com / observatory grade A; `frame-ancestors 'none'` present; the KaTeX residual is documented and unchanged; no functional regression in math rendering.

---

### J — Public exposure of `doc-extract` and `voicebox-proxy`

**Current state — auth gating.** Every proxied route is behind `auth_request /auth/verify` with `error_page 401 = @login_redirect`: `= /doc-extract/extract` (`:281–282`), `= /voicebox/speak` (`:232–233`), `^~ /voicebox/audio/` (`:257–258`). `limit_except` restricts methods (`POST` / `POST` / `GET`). `/auth/verify` is `internal`. The container `/health` endpoints (`auth/main.py:275`, `voicebox-proxy/main.py:164`, `doc-extract/main.py:60`) are **not** proxied by Nginx — `/doc-extract/health` etc. fall through to `location /` (auth-gated static) → not externally reachable. No obvious auth bypass via method, trailing slash (exact-match locations), or path prefix.

**Current state — `doc-extract` resource safety.** `docker-compose.yml:98–105` already sets `cpus: 0.50`, `memory: 256M`, `pids: 30`. `_extract_text` (`doc-extract/main.py:34–51`) reads **every** page (`for page in reader.pages`) into memory and joins; `_MAX_UPLOAD_BYTES` caps input at 15 MB, `_MAX_TEXT_CHARS` caps output at 200 000. **No per-request timeout** — a maliciously crafted PDF (deeply nested objects, decompression-heavy content streams, pathological xref) can make `pypdf` spin CPU or allocate heavily for a long time on the single `uvicorn` worker, blocking other extraction requests.

**Current state — VoiceBox.** `voicebox-proxy/main.py:99–100` sends only `X-Voicebox-Client-Id` (any value accepted by VoiceBox — **not a secret**). VoiceBox itself has **no authentication**. The only access control is VPAL's `auth_request` gate + the `voicebox_speak` rate zone (10 r/m, burst 3). `_start_generation`/`_await_completion` call `${VOICEBOX_URL}` (`:44`, env-overridable); `/voicebox/audio/{id}` restricts `generation_id` to `[A-Za-z0-9_-]{1,128}` (`:51,190`) so no path/scheme injection into the upstream URL.

**Risk in cloud.**
- **VoiceBox no-auth (prominent residual — operator has accepted this):** anything that can send an HTTP request to VoiceBox's port can make the host speak arbitrary text and can read back **every** past generation's audio. If VoiceBox is ever bound to a routable interface, or the `voicebox-proxy` container is compromised, or an SSRF is found, VoiceBox is wide open. There is no credential to check.
- `doc-extract`: a single hostile PDF degrades or denies the document feature for all users (availability/isolation, not a classic DoS-review item).

**Recommendation (provider-neutral).**

*VoiceBox — mandatory compensating network controls (since no auth will be added):*
1. VoiceBox listens on a **private interface only** — loopback or a private subnet address, **never** `0.0.0.0` and **never** a public IP. Verified at deploy time.
2. Firewall / security-group rule: inbound to VoiceBox's port allowed **only** from the `voicebox-proxy` container's address/identity. Default-deny everything else.
3. `voicebox-proxy` reaches VoiceBox over a **private network path only** (VPC/overlay/private link) — no traffic to VoiceBox traverses the public internet.
4. `VOICEBOX_URL` is a private address; drop `extra_hosts: host.docker.internal` in cloud.
5. Egress policy on the `voicebox-proxy` container: allow outbound only to VoiceBox's host:port (limits SSRF blast radius).
6. Keep the `auth_request` gate and the rate limit; consider tightening `voicebox_speak` to a lower rate and a per-user (not just per-IP) key once real IP is fixed (Finding D).
7. Document in `README.md` "Known limitations" and the runbook: **"VoiceBox has no authentication. If the private-network and firewall controls above are not in place, do not enable the VoiceBox path — run Browser TTS only (`currentTTSEngine='browser'`)."**

*doc-extract — availability/isolation:*
1. Add a hard per-request timeout around extraction (e.g. `asyncio.wait_for(run_in_executor(_extract_text, data), timeout=DOC_EXTRACT_TIMEOUT_SECONDS)` with a sane default like 20 s) returning 504; `pypdf` work must run in a thread/process pool so the timeout can actually abandon it — prefer a **subprocess** with `kill` for true CPU-bound cancellation.
2. Keep the existing `cpus`/`memory`/`pids` limits; consider a dedicated lower `cpus` ceiling and running 1 worker so a bad PDF cannot consume a whole node.
3. Consider a page-count cap (reject > N pages before the full loop) in addition to the byte cap.
4. Egress policy: `doc-extract` needs **no** outbound network at all (confirmed self-contained) — enforce default-deny egress on that container.

**Effort.** M.

**Acceptance criteria.**
- Port scan / config review confirms VoiceBox is not reachable from anywhere except `voicebox-proxy`; VoiceBox bind address is private; `voicebox-proxy` egress is restricted to VoiceBox only.
- Runbook contains the explicit "no auth — network-fence or disable" statement; `README.md` updated.
- A crafted pathological PDF to `/doc-extract/extract` returns 504 within the timeout and does not delay a concurrent legitimate extraction.
- `doc-extract` container has no outbound network access.
- All routes still 302→login without a session (no bypass).

---

### K — Logging & monitoring

**Current state.**
- **`auth/main.py`: no `logging` import at all.** No log line for login success, login failure, lockout, replay rejection, `/auth/setup` access, or startup config validation. `_ERROR_MSG` is the only feedback and it goes to the user, not a log.
- `voicebox-proxy/main.py:38` `logger = logging.getLogger("voicebox_proxy")`; logs only failures — `:175` `"Voicebox speak request failed: %s", exc`, `:199` `"Voicebox audio fetch failed: %s", exc`. No `logging.basicConfig` (relies on uvicorn configuring the root logger).
- `doc-extract/main.py:17,44` `logger = logging.getLogger("doc_extract")`; logs `"PDF extraction failed: %s", exc` only. No basicConfig.
- No secrets, TOTP codes, cookies, CSRF tokens, or request bodies are logged anywhere — **confirmed by reading all three modules.** (`exc` values from `httpx`/`pypdf` could contain the upstream URL but not credentials.)
- Healthchecks: `docker-compose.yml:32–38,73–79,111–117` all `python -c "import urllib.request; urllib.request.urlopen('http://localhost:<port>/health')"` — a **liveness** check. No readiness distinction. Nginx healthcheck is `nginx -t` (config-valid, not "is it serving") — a known limitation from `CLAUDE.md`. `/health` endpoints are not proxied, so an external LB health probe has no HTTP path to hit through Nginx.

**Risk in cloud.** With nobody watching `docker logs`, an unlogged brute-force campaign, a wave of lockouts, or unauthorized `/auth/setup` hits are **invisible**. No signal to alert on. Liveness-only checks let a wedged-but-alive process keep receiving traffic.

**Recommendation.**
- **Structured logging** (JSON) in all three services via `logging.config.dictConfig` at startup (works without a shell; distroless-safe). One line per request with: timestamp, service, route, method, status, real client IP (needs Finding D), latency, request-id (accept `X-Request-Id` from Nginx, generate if absent).
- **Auth-event stream** from `auth`: emit discrete events `login_success`, `login_failure` (with reason: unknown_user / bad_code / locked / replay — *without* the code or username-in-clear if privacy matters; at least hash or truncate), `account_locked`, `setup_page_access`, `store_unavailable` (Finding B), `startup_config_invalid`. Never log the TOTP code, `SECRET_KEY`, or any cookie.
- **Readiness endpoints**: add `/readyz` distinct from `/healthz`. `auth/readyz` = `_load_users()` non-empty and (if configured) Redis reachable. `voicebox-proxy/readyz` = process up (do **not** couple readiness to VoiceBox reachability — VoiceBox is optional). `doc-extract/readyz` = process up. Keep `/healthz` as pure liveness.
- **Expose a health path through Nginx** for the LB: an **unauthenticated** `location = /healthz { access_log off; return 200; }` in Nginx (static 200, leaks nothing) OR proxy a single service's `/readyz`. Do not expose the per-service `/health` bodies publicly.
- **Alerting** (operator wires to their platform): failed-auth rate > threshold/5 min, any `setup_page_access` in prod, lockout count spike, `store_unavailable`, 5xx rate, container restart loop.
- Add `logging` to `auth` and `logging.config.dictConfig` to all three.

**Effort.** M.

**Acceptance criteria.** Every auth outcome produces exactly one structured event with no secret material. `/healthz` and `/readyz` distinct and documented. An LB can health-check VPAL over HTTP without a session. A synthetic brute-force run produces alertable log events. Log review confirms no code/secret/cookie/body is ever written.

---

### L — Distributed credential-stuffing / lockout-as-DoS

**Current state.** `nginx.conf` per-IP `auth_api` zone (20 r/m, burst 5) + `auth/main.py:58–70` per-username lockout (5 / 300 s). Login also requires the shared TOTP secret **and** a live 6-digit code (`pyotp` `verify(code, valid_window=1)`), so a blind guess is ~1/1 000 000 per attempt.

**Risk in cloud.**
- A botnet spread over thousands of IPs defeats the per-IP limit; the per-username lockout still holds (5 tries per username per 5 min) — and with only 1–5 known usernames that is actually a tight cap. Combined with the 1/10⁶ TOTP space, online brute force is not a realistic path. The residual concern is enumeration/noise and resource use, not credential compromise.
- **Lockout-as-DoS:** an attacker who knows a username can keep it locked indefinitely (5 bad tries every 5 min = permanent lock) with trivial traffic. For a 1–5-user tool this is a real *availability* nuisance against a named victim.

**Recommendation (this is advisory, not a mandate).**
- Replace the hard lock with **progressive backoff**: after N failures, add an increasing artificial delay / short cooldown rather than a full block, so a legitimate user is slowed but not denied while an attacker is throttled. Cap the delay.
- Or: keep the lock but make its duration escalate only for *sustained* abuse and auto-clear quickly after quiet, so a victim recovers in minutes.
- Optionally add a proof-of-work or CAPTCHA challenge after M failures (adds a client-side dependency and CSP/UX cost — weigh against the low real risk here).
- Per-username lockout should be **per-username, not per-(username,IP)** — it already is; keep it that way so a distributed attack cannot get more than 5 tries/5 min against one account.
- Tune `auth_api` to a per-real-IP key once Finding D lands.
- Document the tradeoff explicitly: hard lock favors confidentiality (stops guessing) at an availability cost (victim lockout); backoff favors availability at a marginal confidentiality cost. Given TOTP already makes guessing ~infeasible, **backoff is the better balance** for VPAL — recommended but left to the team.

**Effort.** M. **Acceptance:** a sustained wrong-code stream from one source is throttled to a crawl; a legitimate user who fat-fingers twice is not locked out for 5 minutes; decision recorded.

---

### M — Supply chain / image ops

**Current state.**
- **Strong:** all four containers digest-pinned distroless Chainguard *for the Python services*, multi-stage, non-root uid 65532, `read_only`, `cap_drop: ALL`, `no-new-privileges`, resource limits (`*/Dockerfile`, `docker-compose.yml`). Monthly `chainguard-digest-check.yml` workflow. `.dockerignore` in each service excludes `tests/`, `.env`/`*.env`, caches, `*.md` (build context is the service subdir, so `.git/`, root `.env`, `deploy/certs/` are already outside it — confirmed).
- **Gaps:**
  - `docker-compose.yml:120` `image: cgr.dev/chainguard/nginx` — **no tag, no digest**. Implicitly `:latest`, unpinned. The one container not reproducible.
  - `*/requirements.txt` pin exact versions (`==`) but are **not hash-locked** (no `--require-hashes`, no lockfile). A compromised-but-same-version package or a registry MitM is not caught.
  - No SBOM generation, no image signing (cosign), no vulnerability scan gate in CI.
  - `docker-compose.yml` is a **dev** descriptor used as-is: `container_name:` set (blocks replicas), `build:` inline (no registry push), no `secrets:` block, `restart: unless-stopped` (fine), `deploy.resources` present (honored by Compose v2). Not a prod deployment descriptor.
  - **CI does not run on `dev`.** `.github/workflows/ci.yml:4–7` triggers only on `master`. A PR into `dev` (the documented base branch) gets **zero** CI — lint, tests, and `nginx -t` never run pre-merge to `dev`. GitHub Actions are pinned to major tags (`actions/checkout@v7`) not commit SHAs.

**Risk in cloud.** Unpinned Nginx image → non-reproducible builds, silent base changes. No SBOM/signing → no provenance, no fast CVE triage. Dev compose as prod → no resource guarantees, no rolling deploy, secrets via file. No CI on `dev` → regressions merge unblocked.

**Recommendation.**
- Pin the Nginx image to a **specific tag + digest** (`cgr.dev/chainguard/nginx:<tag>@sha256:…`); extend `chainguard-digest-check.yml` to cover it.
- Hash-lock Python deps: generate `requirements.txt` with hashes (`pip-compile --generate-hashes` / `uv pip compile`) and install with `--require-hashes`. Keep the `==` pins.
- CI: add `pip-audit`/`npm audit` gates, generate an SBOM (`syft`) per image, sign images with `cosign` (keyless OIDC), scan with `grype`/Trivy and fail on fixable High/Critical.
- Pin GitHub Actions to commit SHAs.
- **Fix CI triggers**: add `dev` to `on.push.branches` and `on.pull_request.branches` (or make it `[master, dev]`). This is a one-line change but is out of scope for *this docs-only PR* — flagged here and in the sequence.
- Produce a **prod deployment descriptor** separate from `docker-compose.yml`: no `container_name`, images by digest from a registry (not `build:`), `secrets:`/env from the platform secret store, explicit `replicas`, rolling-update policy, resource requests+limits, readiness/liveness wired to `/readyz`/`/healthz` (Finding K), the Nginx config-render step (Finding E).
- Keep everything already strong — do not regress the distroless/non-root/read-only posture.

**Effort.** M.

**Acceptance criteria.** Every image referenced by digest. `pip install --require-hashes` succeeds. CI produces a signed image + SBOM per service and fails on fixable High/Critical CVEs. CI runs on `dev` PRs. A prod descriptor exists and is used for cloud deploys.

---

### P — Data-at-rest exposure (confirm & keep minimal) — POSITIVE

**Current state (confirmed by reading the code).**
- **Conversation history is client-side only.** `api.js:104–124,265–272` push messages to the in-memory `conversationHistory` array; `chat.js` `saveChat` serializes it to a file the *user* downloads; it is never POSTed to any VPAL backend. It is sent to Ollama (external, by design) folded into the chat message. `saveChat` strips `imageBase64`/`imageDataUrl` from the export.
- **Uploaded PDFs/images processed in memory, not persisted.** `doc-extract/main.py:78` `data = await file.read(...)`, parsed by `pypdf` in memory, text returned in the JSON response, nothing written. Containers are `read_only: true` with only a `tmpfs /tmp`. Images are resized in the browser and sent as base64 to Ollama; never hit a VPAL backend.
- **VoiceBox generation cache is in-memory only.** `voicebox-proxy/main.py:72` `_generation_cache: OrderedDict`, capped 200 (`:90–91`), cleared on restart. The actual audio lives in the VoiceBox app on the host, not in the container. `/voicebox/audio/{id}` streams upstream bytes through without storing them.
- **Auth has no database.** TOTP secrets from env only; sessions are stateless signed cookies; no session table.
- Nginx `access_log` logs request lines, **not bodies** — chat/document content does not land in logs.

**So server-side data-at-rest is minimal:** nothing to encrypt-at-rest, nothing to back up, no PII store to breach. This is a genuine strength — preserve it.

**Watch-outs / flag if they change.**
- If Finding B adds **Redis**, it will hold usernames + short-lived TOTP-code hashes + attempt timestamps. Keep TTLs short (already 90 s / 300 s), require Redis auth + TLS, private network only, and do **not** start persisting it to disk (RDB/AOF) unless necessary — an in-memory Redis keeps the "minimal data at rest" property.
- If a future feature adds server-side chat storage, RAG/embeddings for documents, or audio caching to disk, that flips this finding — revisit encryption-at-rest, retention, and backup security then.
- The `tmpfs /tmp` is RAM-backed and cleared on restart — keep it that way (do not switch to a disk volume).

**Effort.** S (documentation + Redis hardening rider on Finding B).

**Acceptance criteria.** Runbook records the "no server-side data at rest" property and the conditions that would void it. If Redis is added: auth-required, TLS, private-only, short TTLs, persistence-to-disk consciously decided.

---

## 6. Deployment prerequisites checklist

### 6.1 Required environment variables per service

**`auth`**

| Var | Required | Default | Notes |
|---|---|---|---|
| `SECRET_KEY` | **Yes** | — | ≥ 32 chars; from secret manager; unique per environment. `python -c "import secrets; print(secrets.token_hex(32))"` |
| `SECRET_KEY_FALLBACKS` | No | — | Comma-separated previous keys, for zero-downtime rotation (Finding C) |
| `SESSION_TTL_HOURS` | No | `8` | Absolute session cap |
| `SESSION_IDLE_MINUTES` | No | *(new)* | Idle cap (Finding G) |
| `SETUP_TOKEN` | **Must be UNSET in prod** | — | Enables plaintext TOTP-secret disclosure page. Enrol out-of-band. |
| `USER_1..5` / `TOTP_SECRET_1..5` | ≥ 1 pair | — | `TOTP_SECRET` via `python -c "import pyotp; print(pyotp.random_base32())"` |
| `AUTH_STATE_BACKEND` | Cloud: **`redis`** | `memory` | `memory` refuses to start if replicas > 1 (Finding B) |
| `REDIS_URL` | If backend=redis | — | `rediss://…` (TLS), private network only |
| `REDIS_PASSWORD` | If Redis needs it | — | From secret manager |
| `ALLOWED_HOSTS` | **Yes (cloud)** | — | For `TrustedHostMiddleware` (Finding H) |
| `ALLOWED_ORIGINS` | **Yes (cloud)** | — | Origin check on state-changing routes (Finding H) |
| `DEPLOY_ENV` | Recommended | `local` | `cloud` tightens gates (`SETUP_TOKEN`, backend) |
| `LOG_FORMAT` | No | `json` in cloud | Finding K |

**`voicebox-proxy`** — **no secrets**

| Var | Required | Default | Notes |
|---|---|---|---|
| `VOICEBOX_URL` | Yes (cloud) | `http://host.docker.internal:17493` | **Private address only** (Finding J) |
| `VOICEBOX_CLIENT_ID` | No | `vpal` | Not a secret |
| `VOICEBOX_TIMEOUT_SECONDS` | No | `60` | ≥ slowest synthesis |
| `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` | Yes (cloud) | — | Findings H |

**`doc-extract`** — **no secrets, no outbound network**

| Var | Required | Default | Notes |
|---|---|---|---|
| `MAX_UPLOAD_BYTES` | No | `15728640` | Keep in sync with Nginx `client_max_body_size` on `/doc-extract/extract` and frontend `MAX_DOCUMENT_UPLOAD_BYTES` |
| `MAX_TEXT_CHARS` | No | `200000` | Server sanity cap; frontend `MAX_DOCUMENT_TEXT_CHARS` (28 000) is the real budget |
| `DOC_EXTRACT_TIMEOUT_SECONDS` | Recommended | *(new)* `20` | Hostile-PDF isolation (Finding J) |
| `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` | Yes (cloud) | — | Finding H |

**Nginx (template render — Finding E)**

`OLLAMA_UPSTREAM`, `AUTH_UPSTREAM`, `VOICEBOX_PROXY_UPSTREAM`, `DOC_EXTRACT_UPSTREAM`, `SERVER_NAME`, `TLS_MODE` (`edge`|`acme`|`mounted`), `SSL_CERT_PATH`, `SSL_KEY_PATH`, `REAL_IP_FROM` (LB CIDRs — never `0.0.0.0/0`), `HSTS_MAX_AGE`, `HSTS_INCLUDE_SUBDOMAINS`, `ALLOWED_ORIGIN`, `RESOLVER` (if DNS upstreams).

**Frontend (`src/aia/scripts/config.js`)** — currently hardcoded to `https://localhost/...` (`config.js:4–6`). These are same-origin relative in effect (host must match the browser's address bar). For a non-`localhost` deployment, `OLLAMA_API_URL`, `VOICEBOX_SPEAK_URL`, `DOC_EXTRACT_URL` must point at the real origin (or be made origin-relative). `OLLAMA_NUM_CTX` (`config.js:7`) must equal the Ollama server's real `OLLAMA_CONTEXT_LENGTH`.

### 6.2 Secret generation

```
SECRET_KEY        python -c "import secrets; print(secrets.token_hex(32))"
TOTP_SECRET_N     python -c "import pyotp; print(pyotp.random_base32())"
(SETUP_TOKEN)     python -c "import secrets; print(secrets.token_urlsafe(24))"   # local/enrolment only, never prod env
```
Store all in the platform secret manager. Never commit, never bake into an image, never place on a shared/persistent volume in plaintext.

### 6.3 Pre-flight checklist (all must be true)

- [ ] `SECRET_KEY` ≥ 32 chars, unique to this environment, delivered from the secret manager (not a file in the image/repo).
- [ ] `SETUP_TOKEN` is **unset** in every prod service environment. `GET /auth/setup` returns 404.
- [ ] `voicebox-proxy` and `doc-extract` environments contain **no** `SECRET_KEY` / `USER_*` / `TOTP_SECRET_*` / `SETUP_TOKEN`.
- [ ] `AUTH_STATE_BACKEND=redis` (or `memory` **and** exactly 1 replica, asserted).
- [ ] Redis (if used) requires auth, uses TLS, is reachable only on the private network, and is not persisting secrets to disk unnecessarily.
- [ ] Nginx config rendered from template — no literal `host.docker.internal` / `localhost` / service names / cert paths remain. `nginx -t` passes.
- [ ] `set_real_ip_from` lists only the LB's CIDR(s). Verified: a forged `X-Forwarded-For` from outside does not move the rate-limit bucket or the logged IP.
- [ ] TLS: valid CA-issued cert in use (LB or Nginx). `https://` enforced. HSTS present. `includeSubDomains` decision made; `preload` absent.
- [ ] HTTP→HTTPS behavior correct for the chosen `TLS_MODE` (no redirect loop).
- [ ] VoiceBox bound to a private interface only; firewall permits inbound only from `voicebox-proxy`; `voicebox-proxy` egress restricted to VoiceBox; no public IP anywhere on the VoiceBox path. **If not — VoiceBox path disabled, Browser TTS only.**
- [ ] `doc-extract` has a per-request extraction timeout and default-deny egress.
- [ ] CSP includes `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`. Security-headers scan grade A.
- [ ] `TrustedHostMiddleware` + Origin check active on all three services with env-driven allowlists.
- [ ] Session cookie is `__Host-`-prefixed, `Secure`, `HttpOnly`, `SameSite=Strict`.
- [ ] Structured logging on; auth-event stream verified to contain no secrets/codes/cookies; alerting wired for failed-auth spikes and any prod `/auth/setup` hit.
- [ ] `/healthz` + `/readyz` reachable by the platform; LB health check green.
- [ ] All container images referenced by digest (including Nginx). Vulnerability scan clean of fixable High/Critical.
- [ ] CI runs on the branch being deployed (currently CI is `master`-only — Finding M).
- [ ] Ollama reachable only over the private network; `OLLAMA_NUM_CTX` matches the server.

### 6.4 "Do not deploy if…" (hard gates)

1. `SETUP_TOKEN` is set in any prod service env.
2. Any secret is present in `voicebox-proxy` / `doc-extract` env, or in a git-tracked file, or in an image layer.
3. `AUTH_STATE_BACKEND=memory` with more than one replica.
4. `set_real_ip_from` is unset or `0.0.0.0/0` while behind a proxy/LB (rate limiting is then trivially bypassed / DoS-able).
5. TLS cert is self-signed / for `localhost`, or `https://` is not enforced end-to-end.
6. VoiceBox is reachable from anything other than `voicebox-proxy` (or on a public IP) **and** the VoiceBox path is enabled.
7. `nginx.conf` still contains literal `host.docker.internal` or `localhost` upstreams.
8. Auth emits no logs / no auth-event stream (blind to attacks).
9. `SECRET_KEY` is shared with another environment or is the `.env.example` placeholder.

---

## 7. Out-of-scope & accepted risks

| Item | Decision | Rationale / residual |
|---|---|---|
| Cloud provider specifics (AWS/GCP/Azure IAM, managed Redis, WAF products) | **Out of scope** — operator decision | Plan is provider-neutral by explicit instruction. Operator maps each "requirement" to their platform. |
| **VoiceBox gets no authentication of its own** | **Accepted by operator** | Mitigated **only** by network isolation (Finding J mandatory controls). If those controls are not in place, the VoiceBox path must be disabled. This is the single largest accepted residual. Documented in `TODO.md` "Known Limitations" and `README.md`. |
| VoiceBox has no cancel signal for a fresh generation | Accepted (pre-existing, `TODO.md`) | Fresh synthesis plays to completion on the host; no stop control. Unchanged by cloud. |
| Ollama runs as an external unauthenticated host service | Accepted — same trust model as VoiceBox; the Nginx exact-match proxy + `auth_request` is the only gate | Ollama must be private-network-only. VPAL does not add auth in front of Ollama. |
| KaTeX requires `style-src 'unsafe-inline'` | Accepted (`TODO.md`, `CLAUDE.md`) | Bounded by the rest of the CSP; `trust:false` kept. Finding I keeps the exception. |
| Attached documents are truncated, not RAG-chunked | Accepted (`TODO.md`) | Not a security issue; noted so the plan does not try to "fix" it. |
| Scanned/encrypted PDFs rejected outright (no OCR, no password prompt) | Accepted (`TODO.md`) | Reduces `doc-extract` attack surface if anything. |
| TTS does not speak LaTeX in natural language | Accepted (`TODO.md`) | No security relevance. |
| `protectLatexDelimiters()` covers only a subset of CommonMark escapable punctuation | Accepted (`TODO.md`) | Rendering fidelity, not security (KaTeX `trust:false` bounds it). |
| Generation cache is exact-match, in-memory, no TTL | Accepted (`TODO.md`) | Failure mode is a 404 on replay, not wrong audio. Cloud note: keep it in-memory (Finding P). |
| Document text re-sent every turn / context budget | Accepted (`TODO.md`) | Cost/latency, not security. |
| Server-side chat storage / embeddings / audio-to-disk | **Not built; if added, this plan's data-at-rest finding (P) must be revisited** | Currently a strength — no PII store to breach. |
| Multi-tenant / >5 users / RBAC | Out of scope | VPAL is a 1–5-user single-tenant tool by design. |
| DDoS volumetric protection | Operator's LB/CDN layer | Nginx rate limits are application-layer only. |

---

## 8. Suggested implementation sequence

**Phase 0 — unblock the workflow (do first, tiny):**
- Add `dev` to CI triggers (`.github/workflows/ci.yml`) so everything below is actually tested pre-merge. *(Out of scope for the docs-only PR that introduces this plan; first code change.)*
- Add the missing "Branching & Release Workflow" section to `CLAUDE.md` (or confirm the intended flow) so contributors know `dev` is the base.

**Phase 1 — P0, in dependency order:**

1. **E (Nginx templating)** *first* — it is the substrate for D and F. Introduce `nginx.conf.template` + render step (init container or CI), extend `nginx-config-check` to render then `nginx -t`. No behavior change when defaults match today's values.
2. **D (real_ip + scheme-aware redirect)** — build on the template. Small, high-value.
3. **F (TLS modes)** — build on the template; wire `TLS_MODE`.
4. **C (secret least-privilege + SETUP_TOKEN gate + SECRET_KEY fallback)** — independent of Nginx; can run in parallel with 1–3. Splits `env_file`, adds startup gates.
5. **B (shared auth state)** — the largest single piece. Needs the Redis dependency and the `REDIS_URL` plumbing from C's secret work. Ship `memory` default + `redis` path + fail-closed + `fakeredis` tests.
6. **N (runbook)** — finalize Section 6 as the deploy gate; wire the machine-checkable gates into a pre-deploy CI job. Depends on 1–5 being settled enough to name the env vars.

*Exit Phase 1 → the app is safe to expose.*

**Phase 2 — P1, after exposure is safe but before wide use:**

7. **K (logging + auth events + readiness)** — do early in Phase 2; you want visibility the moment real traffic arrives. Depends on D for real client IP.
8. **H (TrustedHost + Origin checks + default-server)** — small, mostly middleware + template.
9. **I (CSP/headers)** — one config block; ship with H.
10. **G (cookie prefixes + idle expiry)** — small; the `__Host-` rename is a one-time session reset, coordinate with a deploy window. Optional revocation piggybacks on B's Redis.
11. **J (doc-extract timeout + VoiceBox network controls verification)** — the network controls are largely operator/platform work; the `doc-extract` timeout is a small code change.

**Phase 3 — P2, hardening:**

12. **M (image pinning, hash-locked deps, SBOM/signing, prod descriptor)** — ongoing; the prod descriptor should exist by end of Phase 1 in draft, formalized here.
13. **L (lockout → progressive backoff)** — behavior change to auth; do after B (shared state) so backoff state is also shared.
14. **P (data-at-rest confirmation + Redis hardening rider)** — documentation + the Redis-persistence decision from B.

**Dependency summary:** E → {D, F}. C → B (secret plumbing). {B, C, D, E, F} → N. D → K. B → {G-revocation, L}. Everything in Phase 1 → Phase 2/3.
