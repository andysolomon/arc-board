# Story Queue — Design System

A dark, macOS "liquid glass" developer tool. Calm neutral canvas, one blue accent, and a fixed **semantic color set** that encodes pipeline state and worker routes. No gradients-as-decoration, no emoji, restrained motion.

## Foundations

### Surface & depth
Frosted panels over a dim aurora wall. Depth comes from translucency + blur + hairline borders, not heavy shadows.

- **Wall (app background):** layered radial glows on near-black
  `radial-gradient(1100px 780px at 14% 8%, #2a3a6b 0%, transparent 56%), radial-gradient(980px 720px at 88% 16%, #402a63 0%, transparent 52%), radial-gradient(920px 900px at 62% 108%, #14495a 0%, transparent 55%), linear-gradient(158deg, #0f1119, #0a0b11)`
- **Window:** `rgba(24,26,35,0.72)` + `backdrop-filter: blur(44px) saturate(180%)`
- **Panel / card:** `rgba(255,255,255,0.03–0.05)`
- **Hairline borders:** `rgba(255,255,255,0.07–0.12)`
- **Sunken (terminals, code):** `#0a0c11`

### Text (on dark)
- Primary `rgba(255,255,255,0.92)`
- Secondary `rgba(255,255,255,0.6)`
- Tertiary `rgba(255,255,255,0.4)`
- Quaternary / disabled `rgba(255,255,255,0.28)`

### Accent
- Accent `#7c9cff` · Accent-soft `rgba(124,156,255,0.16)`
- On-accent text `#0c0f18`

### Semantic status
| Meaning | Color |
|---|---|
| Queued / accent | `#7c9cff` |
| Running / working / warn | `#f5b544` |
| Review (PR open) | `#c084fc` |
| Done / accepted / success | `#3ecf8e` |
| High priority / error / reject | `#ff6b6b` |
| Write access | `#ff8a5c` |
| Read-only access | `#7c9cff` |

### Worker route colors
| Route | Model | Access | Color |
|---|---|---|---|
| `codex-explore` | gpt-5.4-mini | read-only | `#7c9cff` |
| `composer-implement` | composer-2.5 | write | `#3ecf8e` |
| `codex-implement` | gpt-5.5 | write | `#ff8a5c` |
| `codex-check` | gpt-5.5 | read-only | `#c084fc` |
| `opus-review` | opus-4.8 | read-only | `#f5b544` |
| `fable` (parent) | orchestrator | parent | `#cfd8ff` |

## Type

- **UI:** `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif`, antialiased.
- **Mono (code, ids, paths, metrics):** `ui-monospace, "SF Mono", Menlo, monospace`.

| Role | Size / weight |
|---|---|
| View title (h1) | 19px / 700, tracking -0.02em |
| Drawer title (h2) | 22px / 700 |
| Card title | 13px / 600 |
| Body | 12.5–13.5px / 400–600, line-height 1.45–1.6 |
| Section label | 10–11px / 700, UPPERCASE, tracking 0.05–0.08em, tertiary |
| Mono detail | 10.5–12px |

Never below 10px. Section labels are always uppercase + tracked.

## Shape & spacing

- **Radii:** window 16px · cards 11–14px · inputs/buttons 9–10px · pills/badges 5–7px · dots circular.
- **Spacing scale:** 4 · 6 · 9 · 12 · 14 · 16 · 20 · 24 px. Use flex/grid + `gap`, never margin chains.
- **Board column width:** 262–266px. **Drawer width:** min(600px, 95vw).

## Components

- **Titlebar** 52px: traffic lights, app mark (accent-soft square), project switcher (mono, ▾), Fable status pill, notifications, primary button.
- **Status pill:** dot (with glow + `sqPulse` when live) + label; bg/border tinted by state.
- **Card:** left 4px priority rail, badge row (W-id, issue/PR, DRAFT, BUG·Sn, queue #), title, mono meta, tag chips; running cards show route chip + access chips + worktree + one live terminal line.
- **Badge/chip:** 9.5–10px/700, tinted bg at ~0.14 alpha, radius 5–6px.
- **Drawer:** sticky header (column tag + live worker count), contract block, plan block, criteria (Gherkin), parallel lane terminals, structured handoff JSON, action row.
- **Modal:** centered, `rgba(28,30,40,0.98)` + blur, radius 18px, `sqPop` in.
- **Toast:** bottom-center, dot + message, `sqToast` in, auto-dismiss ~2.6s.
- **Buttons:** primary = accent bg / `#0c0f18` text; secondary = `rgba(255,255,255,0.06)` + hairline; disabled = accent at 0.3 alpha, `not-allowed`.
- **Toggle:** 42×24 track, 18px knob, accent when on.
- **Terminal:** `#0a0c11`, mono 11.5–12px, line-height 1.7, colored by line type (cmd `#e6edf3`, ok `#3ecf8e`, lock `#f5b544`), blinking caret when live.

## Motion

Keyframes: `sqPulse` (live dots), `sqSpin` (spinners), `sqBlink` (caret), `sqStream` (terminal lines in), `sqPop` (modals/menus), `sqToast` (toasts), `sqDrawer` (drawer slide), `sqFade` (scrims), `sqBar` (meter fill). Durations 0.18–0.3s; easing `cubic-bezier(.2,.8,.2,1)`. Motion signals state change only — never decorative.

## Principles

1. **Color is semantic, not decorative** — every hue maps to a pipeline state or route.
2. **Translucency for hierarchy** — blur + alpha, not drop shadows.
3. **Mono for machine facts** — ids, paths, branches, metrics, code.
4. **One accent** — blue leads; status colors punctuate.
5. **Restraint** — no emoji, no gradient fills, motion only on change.
