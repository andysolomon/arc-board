# arc-story-queue — Story Backlog

Gherkin user stories for arc-story-queue itself (distinct from the arc-orchestrator issues the app imports). Two sources:

1. **Bug-fix stories** — defects found while dogfooding the app.
2. **Gap stories** — prototype (`../prototype/Story Queue.dc.html`) + `../BUILD_PROMPT.md` scope we left out or built only partially.

Source of truth for look & feel: `../prototype/Story Queue.dc.html`. Spec: `../BUILD_PROMPT.md`, `../BUILD_SPEC.md`.
IDs continue from the existing `andysolomon/arc-board` backlog (which ends at W-000005).

| ID | Title | Epic | Pri | Size | Kind |
|----|-------|------|-----|------|------|
| W-000006 | Story-execution pull-worker so In-Progress actually runs | Pipeline Execution | P0 | L | gap |
| W-000007 | Honest orchestrator status — "no worker attached" vs live | Pipeline Execution | P0 | M | bug |
| W-000008 | Fable session pull-loop skill (model-driven worker) | Pipeline Execution | P1 | M | gap |
| W-000009 | Parallel worker lanes streaming in the card drawer | Pipeline Execution | P1 | M | gap |
| W-000010 | Review → Done: Merge PR & clean worktree | Pipeline Execution | P1 | M | gap |
| W-000011 | Persist + auto-reattach the last project across reloads/clients | Connectivity | P0 | S | bug |
| W-000012 | Built `.app` reaches the daemon via tauri-plugin-http | Connectivity | P1 | M | bug |
| W-000013 | CORS/loopback regression guard test | Connectivity | P2 | S | bug |
| W-000014 | Pointer-based drag-and-drop that works in the Tauri WebView | Board Fidelity | P1 | M | bug |
| W-000015 | Activity timeline view | View Parity | P1 | M | gap |
| W-000016 | Agent-backed intake with deterministic fallback | View Parity | P2 | M | gap |
| W-000017 | In-drawer "Refine with agent" (Split / Tighten / Dedupe) | View Parity | P2 | M | gap |
| W-000018 | Multi-project switcher — attached sessions, "all" scope, detach | View Parity | P2 | M | gap |
| W-000019 | Liquid-glass shell fidelity pass vs the prototype | Look & Feel | P2 | M | gap |

---

## Epic: Pipeline Execution

### [W-000006] Story-execution pull-worker so In-Progress actually runs
**Epic:** Pipeline Execution · **Priority:** P0 · **Size:** L · **Kind:** gap

## User Story
**ID:** W-000006

As an operator, I want a worker that pulls In-Progress stories and does deterministic work in their worktree so that a card moved to In Progress actually progresses instead of sitting with an empty terminal forever.

## Acceptance Criteria

### Scenario: A reserved In-Progress story is picked up and streamed
**Given** a story is `in_progress` with a created worktree and no worker attached
**When** `npm run worker` connects to the daemon and pulls the story
**Then** the daemon emits `story.update` lines that stream into the card terminal
**And** the story's `run_records` gains at least one row with backend, model, tokens, and duration

### Scenario: Deterministic steps run without invoking a model
**Given** the worker is processing a story in its worktree
**When** it executes its steps
**Then** it only shells out to `git`/`gh` and file operations
**But** it never calls an LLM (the daemon-never-runs-a-model invariant holds)

### Scenario: Completion advances the card and releases the lock
**Given** the worker finishes a story
**When** it calls `story.complete` with a structured handoff
**Then** the card moves to Review
**And** the per-worktree write-lock is released so the next queued story can dispatch

### Scenario: Worker absence is observable
**Given** no worker is connected
**When** a story sits in `in_progress`
**Then** the board shows it as reserved/awaiting a worker (see W-000007)
**But** it is not reported as actively running

## Context
No story-execution client exists today — the only MCP client is `mcp-server/file-agent.ts` (filing bridge). Add `mcp-server/worker.ts` + a `worker` script mirroring the file-agent's connect/pull pattern (`file.pending` → `queue.next`/`story.get` → stream `story.update` → `story.complete`). Verified gap: worktree created at `~/.arc-story-queue/worktrees/…` but branch has 0 commits and `run_records` is empty. A model-driven variant is W-000008.

---

### [W-000007] Honest orchestrator status — "no worker attached" vs live
**Epic:** Pipeline Execution · **Priority:** P0 · **Size:** M · **Kind:** bug

## User Story
**ID:** W-000007

As an operator, I want the Fable status pill and In-Progress column to distinguish "reserved but nobody is working" from "a worker is actively streaming" so that I am not misled into thinking work is happening when it is not.

## Acceptance Criteria

### Scenario: Pill reflects live workers, not column counts
**Given** one story is `in_progress` with no worker connected
**When** I look at the titlebar Fable pill
**Then** it reads an idle/"no worker attached" state
**But** it does not read "1 running"

### Scenario: Pill turns active when a worker streams
**Given** a worker is connected and emitting `story.update` lines
**When** I look at the pill
**Then** it shows the running state with the amber spinner from the prototype

### Scenario: Reserved cards are visually distinct
**Given** a story is `in_progress` with a worktree but no streamed lines
**When** it renders on the board
**Then** the card shows a "reserved · awaiting worker" affordance instead of a live terminal caret

## Context
`app/src/components/AppShell.tsx` derives the pill from the in_progress column count; it must derive from live worker/stream presence (e.g. a `story.update` seen within a recency window, or a daemon-side session/worker registry). Relates to W-000006. Prototype pill: `orchDot`/`orchLabel`/`anyRunning` spinner in the titlebar.

---

### [W-000008] Fable session pull-loop skill (model-driven worker)
**Epic:** Pipeline Execution · **Priority:** P1 · **Size:** M · **Kind:** gap

## User Story
**ID:** W-000008

As a Fable orchestrator running in a live Claude Code session, I want a documented pull-loop skill that connects to the daemon and works the queue so that real model-driven implementation flows through the board.

## Acceptance Criteria

### Scenario: A live session attaches and pulls
**Given** a Claude Code session with the story-queue MCP server configured
**When** the pull-loop skill runs
**Then** it registers a session, attaches its cwd as the project, and pulls the next story via `queue.next`

### Scenario: The session streams and completes through the daemon
**Given** the session is implementing a pulled story
**When** it makes progress
**Then** it streams terminal lines through `story.update`
**And** on finish it posts a structured handoff via `story.complete`

### Scenario: Model work stays in the session, never the daemon
**Given** the session delegates to worker routes
**When** it runs
**Then** all LLM calls happen in the session/Fable
**But** the daemon only records deterministic state

## Context
BUILD_PROMPT step 5–6. This is the model-driven counterpart to the deterministic W-000006. Deliver as a skill/prompt doc plus the thin MCP client glue; reuse the connect pattern from `mcp-server/file-agent.ts`. Endpoint `http://localhost:7420/mcp`.

---

### [W-000009] Parallel worker lanes streaming in the card drawer
**Epic:** Pipeline Execution · **Priority:** P1 · **Size:** M · **Kind:** gap

## User Story
**ID:** W-000009

As an operator, I want the card drawer to show per-worker lanes with their own streaming terminals so that I can watch the write worker and the read-only explore/check workers run concurrently, exactly like the prototype.

## Acceptance Criteria

### Scenario: Lanes render per delegated worker
**Given** a running story with a write worker plus read-only explore and check workers
**When** I open its drawer
**Then** I see one lane per worker with its route label, model, and access badge
**And** the write lane shows a `⚿ write-lock` marker

### Scenario: Each lane streams its own output
**Given** the workers are emitting output
**When** lines arrive over SSE
**Then** each line appends to its own lane's terminal with the streaming animation
**And** the active lane shows a blinking caret

### Scenario: Lane status resolves on completion
**Given** a lane's worker finishes
**When** its final line arrives
**Then** the lane header shows a done status
**But** the caret stops blinking

## Context
Drawer (`app/src/components/StoryDrawer.tsx`) currently renders Plan, Scenarios, and Handoff but not the multi-lane streaming terminals. Prototype: `selLanes` block (`{{ ln.label }}`/`{{ ln.access }}`/`{{ ln.lines }}`, `sqStream`/`sqBlink`). Requires `story.update` events to carry a lane/route identity so lines route to the correct lane.

---

### [W-000010] Review → Done: Merge PR & clean worktree
**Epic:** Pipeline Execution · **Priority:** P1 · **Size:** M · **Kind:** gap

## User Story
**ID:** W-000010

As an operator, I want a "Merge PR & clean worktree" action on a reviewed story so that accepting a result advances it to Done and reclaims the worktree.

## Acceptance Criteria

### Scenario: Merge action appears only in Review
**Given** a story is in the Review column with an open PR
**When** I open its drawer
**Then** a green "Merge PR & clean worktree" button is shown
**But** the button is absent for backlog, queued, in_progress, and done stories

### Scenario: Merging advances the card and frees the worktree
**Given** I click "Merge PR & clean worktree"
**When** the daemon completes the action
**Then** the story moves to Done
**And** its git worktree is removed and its write-lock slot is freed

### Scenario: Worktree cleanup on abandon
**Given** a story is abandoned rather than merged
**When** it is removed from In Progress
**Then** its worktree is cleaned up per policy
**And** the freed slot allows the next queued story to dispatch

## Context
BUILD_SPEC §8 (worktree cleanup) is open. Prototype: `mergeSelected` / "✓ Merge PR & clean worktree". Add a daemon tool (e.g. `story.merge`) that runs `gh pr merge` deterministically + `git worktree remove`, plus the drawer button gated on column === review.

---

## Epic: Connectivity

### [W-000011] Persist + auto-reattach the last project across reloads/clients
**Epic:** Connectivity · **Priority:** P0 · **Size:** S · **Kind:** bug

## User Story
**ID:** W-000011

As a user, I want the app to remember the repo I attached and reconnect to it automatically so that reopening the web or desktop app shows my board without re-entering the path and repo id every time.

## Acceptance Criteria

### Scenario: Reattach on reload
**Given** I have attached a project (path + repo id) and then reload the app
**When** the board connects to the daemon
**Then** it auto-reattaches the last project
**And** the board renders that project's stories without manual steps

### Scenario: Web and desktop each restore independently
**Given** I attached a project in the desktop app
**When** I later open the web app
**Then** the web app restores its own last-attached project from its own storage
**But** an unattached client shows the connect prompt rather than an error

### Scenario: Failed reattach degrades gracefully
**Given** the stored path no longer resolves
**When** auto-reattach runs
**Then** the app shows the connect prompt with a clear message
**But** it does not get stuck on a blank/"Load failed" screen

## Context
`app/src/lib/boardStore.ts` sets `project` in memory only (`patch({ project })`); `connect()` never re-attaches, and web vs Tauri are separate clients. Persist `{ path, repoId }` (localStorage) and re-run attach on connect. Root-caused this session: attachment is lost on every reload.

---

### [W-000012] Built `.app` reaches the daemon via tauri-plugin-http
**Epic:** Connectivity · **Priority:** P1 · **Size:** M · **Kind:** bug

## User Story
**ID:** W-000012

As a desktop user, I want the packaged `.app` to reach the local daemon so that the shipped build works, not just `tauri:dev` and the browser.

## Acceptance Criteria

### Scenario: Packaged app connects to the daemon
**Given** the app is built with `tauri:build` and launched from the `.app`
**When** it starts and connects
**Then** the MCP requests succeed
**But** they are not blocked as mixed content

### Scenario: Requests route through the Rust HTTP layer
**Given** the webview runs at the secure `tauri://localhost` origin
**When** the client makes an MCP call
**Then** the request is issued through `tauri-plugin-http` (or an equivalent native bridge)
**And** the same code path still works in `tauri:dev` and the browser

## Context
progress.txt CONNECTIVITY TODO: the secure `tauri://localhost` origin blocks cleartext http to the daemon (mixed content). Route MCP via `tauri-plugin-http` with a custom fetch injected into `StreamableHTTPClientTransport`. `tauri:dev` and web are unaffected.

---

### [W-000013] CORS/loopback regression guard test
**Epic:** Connectivity · **Priority:** P2 · **Size:** S · **Kind:** bug

## User Story
**ID:** W-000013

As a maintainer, I want an automated test that locks in the loopback CORS fix so that the "Load failed" connection regression cannot silently return.

## Acceptance Criteria

### Scenario: Any loopback origin is allowed
**Given** the daemon is running
**When** a preflight arrives from `http://localhost:5175` (or any loopback port)
**Then** the response allows the origin
**And** it echoes the requested `mcp-protocol-version` header

### Scenario: Non-loopback origins are rejected
**Given** the daemon is running
**When** a preflight arrives from a non-loopback origin
**Then** it is not allowed

### Scenario: Dual-stack bind
**Given** the daemon starts
**When** it binds its listeners
**Then** it accepts connections on both `127.0.0.1` and `::1`

## Context
This session's root cause: allowlist hardcoded to `:5173` while Vite bumped to 5175; `mcp-protocol-version` not echoed; IPv4-only bind. Fix lives in `mcp-server/server.ts` (`isAllowedOrigin`, echoed `access-control-request-headers`, dual bind). Add a vitest over the CORS predicate + a preflight-style assertion.

---

## Epic: Board Fidelity

### [W-000014] Pointer-based drag-and-drop that works in the Tauri WebView
**Epic:** Board Fidelity · **Priority:** P1 · **Size:** M · **Kind:** bug

## User Story
**ID:** W-000014

As a user, I want to drag a backlog card into the Queued lane (and reorder the queue) reliably in the desktop app so that I do not have to fall back to the Enqueue button.

## Acceptance Criteria

### Scenario: Drag backlog → queued enqueues
**Given** a filed (non-draft) backlog card in the desktop WebView
**When** I drag it onto the Queued column and release
**Then** the story is enqueued and appears in Queued

### Scenario: Reorder within the queue
**Given** two or more queued cards
**When** I drag one above another
**Then** the queue order updates to match

### Scenario: Guardrail still blocks unfiled drafts
**Given** a draft card that has not been filed
**When** I drag it onto Queued
**Then** it is rejected with the guardrail message
**But** no queue entry is created

### Scenario: Insertion point is visible while dragging
**Given** I am dragging a card over a droppable lane
**When** it hovers between two cards
**Then** an insertion-line marker shows where it will land

## Context
Reproduced this session: native HTML5 DnD works in Chromium with real timing but fails in the Tauri WKWebView. Replace/augment with a pointer-based drag (pointerdown/move/up) in `Board.tsx`/`BoardColumn.tsx`/`StoryCard.tsx`; include the insertion-line marker deferred in progress.txt. Keep the Enqueue button as the always-available fallback.

---

## Epic: View Parity

### [W-000015] Activity timeline view
**Epic:** View Parity · **Priority:** P1 · **Size:** M · **Kind:** gap

## User Story
**ID:** W-000015

As an operator, I want a dedicated Activity view listing pipeline events over time so that I can see what Fable and I did without opening the notifications popover.

## Acceptance Criteria

### Scenario: Activity appears in the workspace nav
**Given** the app is loaded
**When** I look at the left nav
**Then** an "Activity" item sits between Queue and Observability
**And** selecting it shows the timeline view

### Scenario: Events render as a timeline
**Given** lifecycle events have occurred (queued, started, filed, review, merged, escalated)
**When** I open Activity
**Then** each event shows an icon, subject, text, and relative time in a vertical timeline

### Scenario: Live events append
**Given** the Activity view is open
**When** a new lifecycle event arrives over SSE
**Then** it appears at the top of the timeline without a manual refresh

## Context
Prototype has a full Activity view (`isActivity` block: `activity[]` with icon/subject/text/time). The build only has the NotificationsBell popover and 4 nav views (`AppShell.tsx` NAV lacks Activity). Feed it from the existing lifecycle events already handled in `boardStore.handleLifecycleEvent`.

---

### [W-000016] Agent-backed intake with deterministic fallback
**Epic:** View Parity · **Priority:** P2 · **Size:** M · **Kind:** gap

## User Story
**ID:** W-000016

As a user, I want the "Draft new work" intake to optionally use the model to propose stories (features/PRD/bug) with a deterministic fallback so that intake is smart when a session is available and still works offline.

## Acceptance Criteria

### Scenario: Model-backed generation proposes selectable drafts
**Given** a connected Fable session and text entered in the intake modal
**When** I click Generate
**Then** proposed drafts appear with type badge, priority, title, and a one-line summary
**And** I can deselect any I do not want before creating them

### Scenario: Deterministic fallback when no model is available
**Given** no session is available to run the model
**When** I click Generate
**Then** the deterministic template still produces drafts
**But** the UI indicates the fallback was used

### Scenario: Created drafts obey the filing guardrail
**Given** I create drafts from intake
**When** they land in the backlog
**Then** each is marked DRAFT
**And** none can be queued until filed as a GitHub issue

## Context
BUILD_PROMPT step 6. Today intake is deterministic-only (`mcp-server/intake.ts` `draft()`), and there is no model path. Prototype: intake modal tabs (features/PRD/bug), Generate, `drafts[]`, `exploreNote`. Model calls must run through the session/Fable, never the daemon.

---

### [W-000017] In-drawer "Refine with agent" (Split / Tighten / Dedupe)
**Epic:** View Parity · **Priority:** P2 · **Size:** M · **Kind:** gap

## User Story
**ID:** W-000017

As a user refining a story, I want in-drawer actions to split it, tighten its criteria, or dedupe it against siblings so that I can shape work before it queues.

## Acceptance Criteria

### Scenario: Refine actions are available on a shapeable story
**Given** a backlog story open in the drawer
**When** I view the refine controls
**Then** I see "Split story", "Tighten criteria", and "Dedupe" buttons

### Scenario: Split produces child stories
**Given** I click "Split story"
**When** the refine completes
**Then** the story is replaced/augmented by smaller child stories
**And** a busy spinner shows while it runs

### Scenario: Dedupe reports overlaps
**Given** I click "Dedupe"
**When** the refine completes
**Then** a note summarizes overlaps with other stories
**But** nothing is deleted without my confirmation

### Scenario: Deterministic fallback
**Given** no model session is available
**When** I run a refine action
**Then** a deterministic transform runs
**And** the UI indicates the fallback

## Context
BUILD_PROMPT step 6. Prototype drawer: `refineSplit`/`refineTighten`/`refineDedupe` + `refining`/`dedupeNote`. Not built in `StoryDrawer.tsx`. Model path via session with deterministic fallback.

---

### [W-000018] Multi-project switcher — attached sessions, "all" scope, detach
**Epic:** View Parity · **Priority:** P2 · **Size:** M · **Kind:** gap

## User Story
**ID:** W-000018

As a user with several attached sessions, I want to switch between projects, view an "all" scope, and detach a session so that I can manage more than one repo from one board.

## Acceptance Criteria

### Scenario: Project menu lists attached sessions
**Given** two or more sessions are attached
**When** I open the titlebar project menu
**Then** each attached project is listed with its repo, sub-line, and an active check on the current one

### Scenario: "All" scope aggregates
**Given** multiple attached projects
**When** I select the "all" scope
**Then** Board, Queue, and Observability show stories across all projects
**And** selecting a single project scopes them back down

### Scenario: Detach removes a project
**Given** an attached project in the menu
**When** I click its detach control
**Then** it is removed from the switcher
**But** its daemon-side stories are not deleted

## Context
Prototype titlebar project menu (`projectItems`, `activeProject:'all'`, `p.detach`). Build has a single-project `ProjectSwitcher.tsx` with discover/attach but no multi-project switch, "all" scope, or detach. Scope filtering already keys off `state.project.repo` in `storiesByColumn`.

---

## Epic: Look & Feel

### [W-000019] Liquid-glass shell fidelity pass vs the prototype
**Epic:** Look & Feel · **Priority:** P2 · **Size:** M · **Kind:** gap

## User Story
**ID:** W-000019

As a user, I want the app chrome to match the prototype's dark liquid-glass look so that the shipped app feels like the approved design.

## Acceptance Criteria

### Scenario: Ambient wall background
**Given** the app is open
**When** I view the window behind the panel
**Then** the multi-radial ambient gradient wall from the prototype is present
**And** the panel uses backdrop-blur with the glass border and shadow

### Scenario: Titlebar matches the prototype
**Given** the titlebar renders
**When** I inspect it
**Then** it has the traffic lights, ⌘ mark, "Story Queue" label, repo cycle button, Fable pill, notifications bell, and "+ New Story" in the prototype's layout

### Scenario: Restrained, consistent motion
**Given** overlays and streams animate
**When** they appear
**Then** they use the prototype's keyframes (`sqPop`, `sqDrawer`, `sqToast`, `sqStream`, etc.)
**But** no decorative gradients or emoji are introduced

## Context
Prototype `.sq-root` wall (`--wall` radial gradients), `backdrop-filter: blur(44px)`, titlebar at lines 42–88, keyframes at 25–33. Verify against `app/src/tokens.css` + component styles; this is a fidelity/QA pass, not a rebuild. Constraint from BUILD_PROMPT: dark liquid-glass, one blue accent, semantic status/route colors, mono for machine facts, no emoji/decorative gradients.
