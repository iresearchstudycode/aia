# Session Status — 2026-08-31 (rev 11)

Handoff note for resuming work. Overwrite freely.

## Where things are

| | |
|---|---|
| `master` | `f2bf698` · **v1.29.1** |
| `dev` | `f2bf698` · **v1.29.1** — zero drift both ways |
| `feat/mermaid-repair-md-copy` | **v1.30.0** — pushed, PR into `dev` open, CI running |
| Working tree | clean |
| Docker stack | 7 services healthy. Still owed: a full `docker compose up -d --build` for the Inter woff2, `VPAL_DEFAULT_THEME` default, and the `auth` `<meta color-scheme>` tag. No new service / image / env changes in v1.30.0 (frontend-only). |

## ▶ v1.30.0 — what shipped

**Mermaid "Syntax Error in text" on the Technical Expert persona** + a **copy-markdown button**.

- `_repairMermaid(src)` (`chat.js`, pure/Node-exported) — double-quotes unquoted `()`/`[]`/`{}`/`#` in `graph`/`flowchart` node labels (the mistake `gemma4:e4b` makes constantly, e.g. `D{Web Application Firewall (WAF)}`). `renderMermaidIn()` retries a failed parse once with the repaired source before falling back to `.mermaid-error`.
- `_cleanupMermaidOrphan(id)` — removes the throwaway `#d<id>` measuring `<div>` the vendored v10 `mermaid.render()` leaves on `<body>` when it throws (this *was* the visible error graphic). Guarded to a **direct child of `<body>`** only — the rendered SVG's own root is `#<id>`, so a blind `getElementById` remove would delete the diagram (the first cut of the fix did exactly that; caught in the harness).
- `systemPrompts.technical` (`config.js`) — now instructs `flowchart TD` + always-double-quoted labels + no `subgraph`/`style`/`classDef`.
- `_addMarkdownCopyBtn(contentDiv, rawText)` (`chat.js`) — a `.md-copy-btn` pinned to the top-right of every rendered AI message (faint until hovered) that copies the **raw markdown source** verbatim. Wired into all terminal AI render sites in `api.js` + the plain-markdown branch of `renderConversationHistory`.

Tests: `code-render.test.js` +13 → JS suite **279**. `lint:js`/`lint:html`/`check:sri` clean. Verified end-to-end in an isolated harness (real `mermaid.min.js` + `chat.js`): the exact broken gemma output auto-repairs and renders, garbage still `.mermaid-error`s, zero body-orphan leak.

## ▶ Owed: eyeball the recent releases in the authed app

Everything since v1.27.0 was agent-verified only in isolated harnesses (authed app needs a TOTP login the agent can't do). Sign in at `https://localhost/` (hard-reload) and check:

**v1.30.0:**
1. Technical Expert persona → "create a flow diagram for …" with lots of parens/slashes → renders a diagram, **no red "Syntax Error in text"** graphic, nothing stuck at the bottom of the page.
2. Hover any AI message → a small copy icon appears top-right → click → the clipboard has the raw markdown (`#`, `|` tables, ` ``` ` fences), not the rendered text.

**v1.28.0/1 — themes:** monochrome UI, Settings → Interface → Theme = System/Light/Dark instant apply (watch the send button flip), no white flash on reload with Dark active, `/auth/login` monochrome in OS light + dark.

**v1.29.0 — personas:** history grouped into collapsible per-persona sections (icon + name + count), most-recently-used first, "Unassigned" last, collapse persists; header ▾ picker shows `icon · name · ✓`, "Claude Prompt Compressor" gone; replies in Australian English.

**v1.27.0/1** (low-risk, never checked): console `console.log(currentNumCtx, modelContextLengths)` → `16384` + populated map; thin scrollbars; Settings Export/Import as pills.

## Deploy note that bit us twice this session

Frontend static files (`src/aia/`) are **bind-mounted** → live on browser reload. The **Python services run from built images** — a `settings-service/main.py` change needs `docker compose build settings-service && docker compose up -d settings-service`. **v1.30.0 touches no Python service**, so a browser hard-reload is enough.

## Next up (feature backlog)
Per-persona affordances (Teacher quiz/flashcards, Consultant SWOT/decision-matrix templates, Transcript source pane + citations); document RAG instead of 28K truncation; OCR / encrypted-PDF in doc-extract; cloud-hardening findings past Finding E.
