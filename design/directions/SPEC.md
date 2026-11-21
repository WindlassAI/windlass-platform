# Design directions — shared spec

A direction study for the Windlass platform's web app and landing page. Static mockups only: nothing here
is wired into `web/`. Three directions, one folder each, built from the same content so they compare
fairly.

## What the owner asked for

- No serif type anywhere (today's Newsreader headings go).
- The app and landing look sloppy and plain; the landing should show the product more vividly.
- The controls under the composer (a row of mono text chips: `repo … @ main ▾  on linux arm64 machine ▾
  agent Claude Code · Sonnet 5.5 ▾  mode Auto ▾  sandbox Hardened Docker… ▾`, then `Enter launch · Shift+Enter
  new line` and `Create without a prompt`) are clumsy, on phone too.
- Pickers open oversized boxes (today a picker opens the whole old launch form: profile cards with layer
  diagrams). Menus must be compact and well sized.
- Stay unique: the windlass mark (drum + line + weight), nautical restraint, an agent at work. Polish the
  interactions; do not copy anyone.

## Shared interaction model (every direction)

**Four controls, not five chips.** Where it runs and its sandbox are one choice (a place, then a profile
inside it), so the composer has:

1. **Agent · model** (+ effort where the model has efforts) — Windlass: GPT-6.1 Sol (default; efforts low,
   medium, high, xhigh, max), GPT-6 Sol (low, medium, high), GPT-6 Luna. Claude Code: Opus 5.5 (default),
   Sonnet 5.5, Haiku 5.5 — only on a machine where Claude Code is signed in.
2. **Where** — Hosted (E2B microVM, "suspends when idle") or a machine: `d5eb81` Linux arm64 online,
   `studio-mac` macOS offline (last seen 3 h ago). Inside a machine, the sandbox profile:
   *Docker + Windlass sandbox* ("each command sandboxed · no network · asks first") or *Hardened Docker*
   ("network on · token readable"). Show a profile's promise as 2–3 tiny facts, not a paragraph.
3. **Repository @ branch** — `northwind/harbor-web` @ `main` (recent), `northwind/harbor-api`,
   `northwind/tide-docs`, `northwind/infra`, `personal/dotfiles`, … (long list: filter field). Branches:
   main, release/2.4, wl/metres-feet.
4. **Mode** — Windlass: Ask ("asks before writes, commands, network"), Auto ("sandboxed, asks when
   needed"). Claude Code: Default, Accept edits, Plan, Auto ("assesses tool permissions itself").
   A small control, not a dropdown with paragraphs.

- **Launch** is the primary button. "Create without a prompt" moves into the launch button's split menu
  (or the `+` menu). Keyboard hints (`↵ launch · ⇧↵ new line`) appear only while the composer has focus,
  small, and never as a separate line of text under it.
- A control whose value differs from the saved default gets a subtle dot; a warning (machine offline,
  open sandbox) shows as an amber dot plus one line inside its picker.

**Menus and popovers (every direction).**
- Sized to content: 240–340px wide, never page-wide. Anchored to the trigger (left edges aligned, 6–8px
  gap), opening down, flipping up near the bottom.
- max-height ≈ 360px with internal scroll; a sticky filter field at the top of long lists ("Filter
  repositories…" — type-to-filter, matched letters highlighted).
- Items 30–34px tall, 13px label, 12px secondary text in the faint ink, a leading icon/glyph, a check
  for the chosen one; grouped with small headers; a hairline between groups.
- Keyboard: ↑↓ move, ↵ choose, ⎋ close, → into a submenu (e.g. a machine → its profiles), typeahead.
  A quiet footer row shows those keys.
- Show the keyboard-highlighted row (one row in the open state should look "active").
- Motion: 120–160ms scale(.98)+fade from the trigger's corner; no bounce on menus.
- **Phone:** no floating boxes. Pickers are bottom sheets (grab handle, title, 44px rows, safe-area
  padding, the page dimmed behind). The composer's controls collapse into one summary row that opens a
  "Launch settings" sheet; choosing a setting pushes its list in the same sheet (with a back chevron).

## Shared content (use the same data everywhere)

- Product: **Windlass**. Mark (SVG, 28×28 viewBox, stroke currentColor, width 2, round caps):
  ```html
  <svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11.5" cy="11.5" r="7.5"/><path d="M11.5 4v4.2M5 15.25l3.64-2.1M18 15.25l-3.64-2.1"/><circle cx="11.5" cy="11.5" r="1.5" fill="currentColor" stroke="none"/><path d="M19 11.5V23"/><rect x="17" y="22" width="4" height="4" rx="1" fill="currentColor" stroke="none"/></svg>
  ```
  The drum may turn while an agent works (CSS rotate on the drum group).
- App nav: Agents · Factory · Machines · Docs; account menu (initial "P"); theme toggle.
- Home header facts: 5 agents · 1 working · 1 needs you. Usage: sandbox time today 14 min of 2 h ·
  3 of 5 sandboxes kept.
- Agents list (group by repository `northwind/harbor-web`):
  - "Fix the flaky slug test" — **working**, step 6, 2m 14s, Windlass · GPT-6.1 Sol, hosted.
  - "Bump vite to 7 and fix the types" — **needs you**: "Run `pnpm install` with network access?",
    Claude Code · Sonnet 5.5, d5eb81.
  - "Metres and feet settings panel" — **done**, 37 turns, PR #142 open, checks passed, 2 h ago.
  - "Add CSV export to orders" — **done**, PR #139 merged, yesterday.
  - Work item (Factory) "Rate-limit the public API" — at **review** (step 6 of 7).
- Session mid-turn (title "Metres and feet settings panel", Claude Code · Sonnet 5.5 on d5eb81, Hardened
  Docker, mode Auto, branch `wl/metres-feet`, turn 3, working 1m 48s):
  - person: "Let people switch the settings panel between metres and feet. Keep it per user."
  - thought (collapsed): "The unit lives in two places: the panel and the formatter."
  - read `web/src/settings/Panel.tsx` · 212 lines · 9 ms
  - read `web/src/lib/format.ts` · 88 lines
  - edit `web/src/settings/UnitsToggle.tsx` · new file · +48
  - edit `web/src/lib/format.ts` · +11 −3 (diff card with 6 lines)
  - plan: 4 steps — add the toggle ✓, store per user ✓, format lengths ●(now), test both units ○
  - shell `pnpm vitest run settings` — **running 12 s**, streaming tail: `✓ format › metres (3)` /
    `✓ format › feet (3)` / `… UnitsToggle › persists the choice`, with a Stop button for that call.
  - Steering composer at the bottom: "Steer — read at its next step", plus Stop turn.
  - Side panel: Session (agent, model, mode, sandbox, machine, branch), Context 38% (bar), Cost so far
    $0.42, Files changed 3 (+59 −3), Pull request: none yet (Publish button disabled until the turn ends),
    Checks: last run passed.
- Landing truths (stay within them): runs Windlass (its own agent) and Claude Code; OpenCode and Codex
  planned. Sandboxes hosted (Firecracker microVM by E2B) or a Linux machine with Docker via a runner that
  dials out. Watch every file read / command run live; steer mid-turn; answer questions (allow once / for
  the session / decline); read the diff; publish a PR via the GitHub App. Factory: file → implement →
  check → pull request → CI → review → ready for you; never merges. By invitation, no pricing.

## Files per direction (`design/directions/<name>/`)

| file | what | shots (into `shots/`) |
|---|---|---|
| `home.html` | Agents home with the composer, desktop. `?state=open` opens this direction's picker; `?theme=light|dark`. | `home-dark.png`, `home-dark-open.png`, `home-light-open.png` (1440×900) |
| `home-phone.html` | Agents home on a phone. `?state=sheet` opens the picker as a bottom sheet. | `phone-dark.png`, `phone-dark-sheet.png`, `phone-light-sheet.png` (390×844) |
| `session.html` | Session mid-turn with steering composer and side panel. | `session-dark.png`, `session-light.png` (1440×900) |
| `landing.html` | Landing hero + one product section; responsive. | `landing-dark.png`, `landing-light.png` (1440, full page), `landing-phone-dark.png`, `landing-phone-light.png` (390, full page) |

Render with `design/directions/shoot.sh <page> <out.png> <w> <h> "<query>" [--full]`. Each page reads
`theme` and `state` from `location.search` with a few lines of inline script and sets
`data-theme`/`data-state` on `<html>`; default theme is the direction's primary one.
Self-contained: inline CSS, Google Fonts `<link>` only, inline SVG icons, no external images, no build.
Light and dark both, from one set of tokens on `:root` / `[data-theme]`.
