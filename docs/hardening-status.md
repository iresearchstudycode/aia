# VPAL Security Hardening — Status & Handoff

**Last updated:** 2026-08-28
**State:** ⏸ **PAUSED** after Finding E. No hardening work in progress, no open PRs, no running sub-agents. `dev` is at **v1.16.0** (`c255a32`), 4 commits ahead of `master`, no divergence. Local Docker stack rebuilt and healthy on `dev`.

Detailed spec for every finding: [`docs/cloud-hardening-plan.md`](cloud-hardening-plan.md). This file tracks progress against it.

---

## 1. Session summary (2026-08-27 → 2026-08-28)

| # | Work | Outcome |
|---|---|---|
| 1 | Project status review | Established: `dev` was 1 feature commit ahead of `master` (unreleased v1.15.0); TODO.md all checked; stale Dependabot remote-tracking refs only. |
| 2 | Release **v1.15.1** | **PR #17** merged to `master`: KaTeX math rendering, document attachment + new `doc-extract` service, ChatGPT-style attach menu, explicit `num_ctx`. Also folded in the js-yaml security bump (below). |
| 3 | Dependency / security fixes | `js-yaml` 3.15.0→3.15.2 (Dependabot alert #17, **high**, CVE-2026-59870, quadratic CPU in `!!omap`) — shipped in PR #17. `pypdf` 6.14.2→6.15.0 (**PR #18**, `doc-extract`). **All Dependabot alerts now 0 open** (16 historical, all `fixed`). |
| 4 | Branch/release workflow fix | **PR #19**: documented the `dev`→`master` **merge-commit** rule + post-merge fast-forward sync in `CLAUDE.md`; set Dependabot `target-branch: dev` on both ecosystems. Fixes the recurring post-squash-merge `dev`/`master` divergence that had required `git reset --hard` after #17. Also pruned 12 stale local remote-tracking branches. |
| 5 | Security review | Reviewed the v1.15.0 diff (`065dd3d..df9ec77`) for **newly-introduced** vulnerabilities. **None found** at ≥0.7 confidence — new attack surface (doc-extract PDF parsing, KaTeX, attach menu, CSP `style-src 'unsafe-inline'`) is consistent with the existing security model. |
| 6 | Cloud-hardening plan | **PR #20**: [`docs/cloud-hardening-plan.md`](cloud-hardening-plan.md) — 15 prioritized findings (**6 P0 / 5 P1 / 4 P2**), each with `file:line`, cloud risk, provider-neutral fix, effort, acceptance criteria; deployment runbook; accepted-risks section. Analysis only, no code changes. Decisions fixed by the user: **platform-agnostic**, Ollama/VoiceBox stay external + env-parametrized, **no auth added in front of VoiceBox** (network isolation only). |
| 7 | CI on `dev` | **PR #21**: `.github/workflows/ci.yml` now triggers on `push` + `pull_request` for `[master, dev]` (was `master`-only). Hardening PRs into `dev` now get the full lint/test/`nginx -t` gate. Confirmed running green. |
| 8 | **Finding E** — nginx config parametrization | **PR #22** (v1.16.0, `c255a32`). See §2. |
| 9 | Local stack repair | `deploy/certs/` was empty → `vpal-nginx` had been `unhealthy` ~22 h (serving on an in-memory cert; any restart would have failed). Regenerated mkcert certs (`localhost`, `127.0.0.1`, `::1`, valid to 2028-11), `docker compose build` (picks up `pypdf` 6.15.0) + `up -d`. **All 4 containers healthy**, serving v1.16.0 at `https://localhost/`. Both required Ollama models present (`gemma4:e4b`, `gemma3:4b`). |

**Delivery model:** one scoped sub-agent per item — **Haiku** for mechanical config work, **Sonnet** for anything touching auth or secrets. Each works on its own branch → PR into `dev`; the parent session reviews every diff and the CI result; the **user merges** (the parent session cannot run `gh pr merge` — classifier-blocked).

**This session's PRs:** #17, #18 (merged to `master`) · #19, #20, #21, #22 (merged to `dev`).

---

## 2. Completed hardening work

### Phase 0 — workflow prerequisites
- [x] **CI runs on `dev`** — PR #21.
- [x] **Branching & Release Workflow** — PR #19 (`CLAUDE.md` section; Dependabot retargeted to `dev`).

### Findings
- [x] **E — nginx config parametrization** — PR #22, v1.16.0.
  - `deploy/nginx/nginx.conf.template` — 7 `${...}` placeholders: `AUTH_UPSTREAM`, `VOICEBOX_PROXY_UPSTREAM`, `DOC_EXTRACT_UPSTREAM`, `OLLAMA_UPSTREAM`, `SERVER_NAME` (×2), `SSL_CERT_PATH`, `SSL_KEY_PATH`. All nginx runtime `$vars` left literal.
  - `deploy/nginx/render-nginx-conf.sh` — POSIX `sh`, `envsubst` with an **explicit variable allowlist**, defaults = today's literals.
  - `deploy/nginx/nginx.conf` — now a **generated artifact**; CI `nginx-config-check` gained a drift guard (render-with-defaults must equal the committed file) + a cloud-render sanity check.
  - `.env.example` + `CLAUDE.md` "Nginx Proxy" updated.
  - Round-trip verified byte-identical (only the one intended `proxy_pass` comment line differs). CI green.
  - **Deferred sub-item → tracked as `E-followup` in §3.** `docker-compose.yml` still bind-mounts the committed `nginx.conf` (the local-default render). A fully template-driven runtime (init container rendering the template into a shared volume for the distroless nginx) is **not** done.

---

## 3. Remaining hardening tasks

Order follows [`cloud-hardening-plan.md` §8](cloud-hardening-plan.md) (dependency sequence). "Model" = recommended sub-agent model.

### P0 — resolve before any internet exposure

| ID | Task | Depends on | Model | Effort | Notes |
|---|---|---|---|---|---|
| **D** | `set_real_ip_from` / `real_ip_header X-Forwarded-For` / `real_ip_recursive on` so rate limits + logs see the true client IP behind an LB; `$http_x_forwarded_proto`-aware HTTP→HTTPS redirect | E ✓ | Haiku* | S | *Wrinkle: `set_real_ip_from` with an empty value is invalid nginx, and `envsubst` can't do conditionals. Likely render the directive into a separate `real-ip.conf` `include` only when `REAL_IP_FROM` is set, or have `render-nginx-conf.sh` emit the line conditionally. Re-verify the round-trip + CI drift guard. |
| **F** | `TLS_MODE` switch (`edge` / `acme` / `mounted`); parametrized cert paths (done in E); HSTS `includeSubDomains`/`preload` review; the `listen` directive and HSTS-emitting server block vary by mode | E ✓ | **Sonnet** | M | Not pure envsubst — `listen 443 ssl` vs plaintext-on-private-port, and which server block emits HSTS, change by mode. |
| **C** | Split `.env` so `voicebox-proxy` / `doc-extract` receive **no** secrets; hard-gate `SETUP_TOKEN` off in prod (**`GET /auth/setup` renders plaintext TOTP seeds, unauthenticated** — only token-gated); `SECRET_KEY` + `SECRET_KEY_FALLBACKS` for zero-downtime rotation | — | **Sonnet** | M | Touches `auth/main.py` + `docker-compose.yml`. Independent of the nginx work — can run in parallel with D/F. |
| **B** | Redis-backed brute-force lockout + TOTP-replay cache (`AUTH_STATE_BACKEND=memory\|redis`, `SET NX EX` atomicity, **fail-closed** on store outage, `fakeredis` test path, `memory` default refuses >1 replica) | C (secret plumbing) | **Sonnet** | M | Largest single piece. Security-critical rewrite of `auth/main.py` state (`_failed_attempts`, `_used_totp_codes`). |
| **N** | Deployment runbook + **machine-checkable pre-deploy CI gate** (env-var contract per service, "do not deploy if…" hard gates from plan §6.4) | B–F settled | Haiku | M | Needs the final env-var names from B/C/D/F. |
| **E-followup** | `docker-compose` init/sidecar container that renders `nginx.conf.template` → shared volume for the distroless runtime, so the committed `nginx.conf` is no longer the runtime source of truth | E ✓ | Sonnet | M | Named volume + `command`/healthcheck override on the Chainguard image + `depends_on: service_completed_successfully`. |

### P1 — after exposure is safe, before wide use

| ID | Task | Model |
|---|---|---|
| **K** | Structured (JSON) logging in all 3 services — **`auth/main.py` currently imports no `logging` at all**; auth-event stream (login success/failure/lockout/replay/`setup` access/`store_unavailable`); `/readyz` distinct from `/healthz`; an unauth `location = /healthz { return 200; }` in nginx for LB probes; alerting hooks for failed-auth spikes | Haiku / Sonnet |
| **H** | `TrustedHostMiddleware` (allowed-hosts from env) on all 3 FastAPI apps; nginx `server { server_name _; return 444; }` default block; `Origin`/`Referer` check on state-changing routes as a second CSRF layer | Sonnet |
| **I** | CSP: add `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`, `upgrade-insecure-requests`; add `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy: same-origin`. KaTeX `style-src 'unsafe-inline'` stays (documented, bounded). | Haiku |
| **G** | `__Host-` cookie name prefix; explicit `Path=/`, no `Domain`; idle + absolute session expiry (`last_seen`/`iat` in the signed payload); document the deliberately non-HttpOnly cookies; optional Redis-backed revocation (piggybacks on B) | Sonnet |
| **J** | `doc-extract` per-request extraction timeout (subprocess + kill for CPU-bound cancel) + default-deny egress; re-verify no auth bypass on the public routes; **VoiceBox mandatory network-isolation controls** (private bind, firewall inbound only from `voicebox-proxy`, restricted egress) + `README.md` "no auth — fence or disable" note | Sonnet |

### P2 — hardening

| ID | Task | Model |
|---|---|---|
| **M** | Pin `cgr.dev/chainguard/nginx` by tag + digest (**currently unpinned** — the one non-reproducible container); hash-lock Python deps (`pip-compile --generate-hashes` + `--require-hashes`); SBOM (`syft`) + `cosign` signing + Trivy/grype gate in CI; pin GitHub Actions to commit SHAs; a **prod deployment descriptor** separate from the dev `docker-compose.yml` | Sonnet |
| **L** | Replace the hard per-username lockout with **progressive backoff** (mitigates lockout-as-DoS against a named victim); per-user rate-limit key once D lands | Sonnet |
| **P** | Document the "no server-side data at rest" property + the conditions that would void it; Redis hardening rider (auth required, TLS, private-only, short TTLs, **no** RDB/AOF disk persistence) | Haiku |

### Not tasks — accepted risk / out of scope (plan §7)
- Cloud-provider specifics — platform-agnostic by decision.
- **VoiceBox gets no authentication of its own** — mitigated by network isolation only (Finding J controls). If those aren't in place, the VoiceBox path must be disabled (Browser TTS only). Single largest accepted residual.
- Ollama runs as an external unauthenticated host service — must be private-network-only; VPAL adds no auth in front of it.
- KaTeX `style-src 'unsafe-inline'` — bounded by the rest of the CSP; `trust:false` kept.
- Multi-tenant / >5 users / RBAC; volumetric DDoS (operator LB/CDN layer).

---

## 4. How to resume

1. Confirm `dev` is clean, synced, and has **no open PRs**. Merge any outstanding hardening PRs, then `git checkout dev && git pull --ff-only origin dev`.
2. **Next task: D.** Scope a sub-agent to the `real_ip` + scheme-aware-redirect changes against `nginx.conf.template` / `render-nginx-conf.sh` / CI / docs — mind the empty-`REAL_IP_FROM` wrinkle noted in §3. Same discipline as E: byte-identical round-trip with defaults, CI drift guard must pass.
3. Then **C → B → F → E-followup → N**, then **P1** (K, H, I, G, J), then **P2** (M, L, P). One sub-agent per item; parent reviews each diff + CI; user merges.
4. When P0 is complete, run through the plan's §6.3 pre-flight checklist and §6.4 "do not deploy if…" gates before any cloud exposure.

**Local test loop:** `mkcert` certs must exist in `deploy/certs/`; `docker compose build && docker compose up -d`; `https://localhost/`. Regenerate certs with `mkcert -cert-file deploy/certs/localhost.pem -key-file deploy/certs/localhost-key.pem localhost 127.0.0.1 ::1` if `deploy/certs/` is empty.
