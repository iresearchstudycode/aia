# Session Status — 2026-08-31 (rev 13)

Handoff note for resuming work. Overwrite freely.

## Where things are

| | |
|---|---|
| `master` / `dev` | **v1.31.0** at `06e660b`, zero drift |
| `fix/mermaid-repair-edge-labels` | **v1.31.1** — `_repairMermaid` edge labels/classDef + wide-flowchart scroll; PR into `dev` |
| Working tree | clean |
| Docker stack | 7 services healthy. Still owed: a full `docker compose up -d --build` for the Inter woff2, `VPAL_DEFAULT_THEME` default, and the `auth` `<meta color-scheme>` tag. v1.30–1.31.x are all frontend-only — no service / image / env changes. |

## ▶ v1.31.1 — what shipped

A qwen3.5:9b Technical-Expert flowchart still errored. Its source had unquoted `{}`/`"`/`/` **inside edge labels** (`-->|... {"model":"x"}|`), a literal `& \n`, `<br/>`, `classDef` + `:::class` — none of which v1.30.0's node-label-only `_repairMermaid` touched.

- **`_repairMermaid` rewrite** (still runs only as the post-failure retry → free to be aggressive): drop `classDef`/`style`/`linkStyle` + `:::class`; collapse `\n` junk; strip `<br/>`; quote **node AND edge** label text with punctuation past `\w \s / . -`. Verified e2e against real `mermaid.min.js` + the user's exact diagram → parse error to full render, 40 legible labels.
- **Wide flowcharts no longer shrink to unreadable** — `flowchart.useMaxWidth: false` + `.mermaid-diagram svg { display:block; margin:0 auto }`: natural size + horizontal scroll inside the card. (This was likely most of "not rendering correctly" — a 2100px-wide diagram was being scaled into ~390px, ~2px text.)

Tests: `code-render.test.js` +5 → JS suite 289. CSP unchanged.

## ▶ v1.31.0 — what shipped

**Mermaid diagrams: Rational Rose styling + fixing silently-missing node text.**

- **The real bug:** Mermaid v10 renders node labels inside `<foreignObject>` XHTML *even under `securityLevel: 'strict'`*, and DOMPurify's SVG profile strips `<foreignObject>` — so every diagram was rendering with **its node text gone**. `htmlLabels: false` (top-level + per diagram type) forces plain SVG `<text>`/`<tspan>`, which survive the sanitiser. This is what the user was seeing when they asked for "clearly display both the diagram elements and their associated text".
- **Rose look:** `mermaid.initialize` `theme: 'dark'` → `theme: 'base'` + full `themeVariables` (paper canvas `#fbfaf3`, cornsilk boxes `#fff8dc`, dark-navy borders `#33334d`, near-black text, sticky-note-yellow notes). New `--mermaid-*` tokens in `style.css` on bare `:root` (light in both themes, like `--code-bg` stays dark), mirrored by a `ROSE` object in `chat.js`. `.mermaid-diagram` gets the paper bg + border + a `!important` text-fill safety net.
- **Colour coding:** `_colourCodeMermaidNodes(wrapper)` — post-sanitisation DOM pass (`.style.fill`, no `innerHTML`) recolouring flowchart nodes by shape: `polygon` → decision → amber, `circle`/stadium → terminator → sage, else cornsilk.

Tests: `code-render.test.js` +5 → JS suite **284**. Harness-verified against real `mermaid.min.js` + `style.css`: flowchart / sequence / class all render with **visible** legible text, decisions amber, terminators sage, paper canvas holds in dark mode, zero body-orphan leak. CSP unchanged.

## ▶ v1.30.0 — what shipped

**Mermaid "Syntax Error in text" on the Technical Expert persona** + a **copy-markdown button**.

- `_repairMermaid(src)` — double-quotes unquoted `()`/`[]`/`{}`/`#` in `graph`/`flowchart` node labels; `renderMermaidIn()` retries a failed parse once with the repaired source.
- `_cleanupMermaidOrphan(id)` — removes the `#d<id>` `<body>` orphan the vendored v10 `mermaid.render()` leaves on throw (this *was* the visible error graphic), guarded to a direct `<body>` child.
- `systemPrompts.technical` — `flowchart TD` + quoted labels + no `subgraph`/`style`/`classDef`.
- `_addMarkdownCopyBtn(contentDiv, rawText)` — a `.md-copy-btn` top-right of every rendered AI message that copies the raw markdown source.

## ▶ Owed: eyeball the recent releases in the authed app

Everything since v1.27.0 was agent-verified only in isolated harnesses (authed app needs a TOTP login the agent can't do). Sign in at `https://localhost/` (hard-reload) and check:

**v1.31.0:**
1. Technical Expert persona → ask for a flow diagram → it renders with **visible node text** (this was missing before), cornsilk boxes, amber decision diamonds, sage start/end, dark text, on a light "paper" card — same in light *and* dark app theme.
2. A sequence / class diagram → same paper-card treatment, all labels legible.

**v1.30.0:**
1. Technical Expert flow diagram with lots of parens/slashes → renders, **no red "Syntax Error in text"** graphic, nothing stuck at the bottom of the page.
2. Hover any AI message → a small copy icon appears top-right → click → the clipboard has the raw markdown (`#`, `|` tables, ` ``` ` fences), not the rendered text.

**v1.28.0/1 — themes:** monochrome UI, Settings → Interface → Theme = System/Light/Dark instant apply (watch the send button flip), no white flash on reload with Dark active, `/auth/login` monochrome in OS light + dark.

**v1.29.0 — personas:** history grouped into collapsible per-persona sections (icon + name + count), most-recently-used first, "Unassigned" last, collapse persists; header ▾ picker shows `icon · name · ✓`, "Claude Prompt Compressor" gone; replies in Australian English.

**v1.27.0/1** (low-risk, never checked): console `console.log(currentNumCtx, modelContextLengths)` → `16384` + populated map; thin scrollbars; Settings Export/Import as pills.

## Deploy note that bit us twice this session

Frontend static files (`src/aia/`) are **bind-mounted** → live on browser reload. The **Python services run from built images** — a `settings-service/main.py` change needs `docker compose build settings-service && docker compose up -d settings-service`. **v1.30.0 and v1.31.0 touch no Python service**, so a browser hard-reload is enough.

## Next up (feature backlog)
Per-persona affordances (Teacher quiz/flashcards, Consultant SWOT/decision-matrix templates, Transcript source pane + citations); document RAG instead of 28K truncation; OCR / encrypted-PDF in doc-extract; cloud-hardening findings past Finding E.
