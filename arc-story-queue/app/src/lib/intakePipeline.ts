import type {
  GherkinScenario,
  IntakeDraftProposal,
  IntakeDraftSource,
  IntakeGenerateResult,
  IntakeKind,
  Project,
  Story,
} from "arc-contracts";

/**
 * Intake pipeline adapter — the seam that owns the intake request → proposal
 * flow so the board stays a thin client. Everything here is either pure
 * (prompt construction, JSON parsing, scenario/draft normalization,
 * deterministic fallback) or takes an injected `modelComplete` and never
 * touches board state, transport, or persistence.
 *
 * The core invariant: model invocation stays in the live Fable/app session via
 * the injected `modelComplete`. It is NEVER moved into the daemon. This module
 * only constructs the prompts and normalizes what the model returns into the
 * same `IntakeDraftProposal` shape the deterministic fallback produces.
 */

export interface ModelCompleteArgs {
  system: string;
  max_tokens: number;
  messages: Array<{ role: "user"; content: string }>;
}
export type ModelComplete = (args: ModelCompleteArgs) => Promise<string>;

export interface IntakePipelineDeps {
  modelComplete: ModelComplete | null;
  project: Project | null;
}

export type RefineAction = "split" | "tighten" | "dedupe";

// --- pure text helpers -----------------------------------------------------

export function cap(s: string): string {
  const trimmed = s.trim().replace(/^[-*\d.)\s]+/, "");
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : "Untitled";
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "draft";
}

export function linesFromText(text: string, fallback: string[]): string[] {
  const lines = text
    .split(/\n|(?<=[.;])\s+/)
    .map((s) => s.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((s) => s.length > 3);
  return (lines.length ? lines : fallback).slice(0, 4);
}

export function guessEpic(text: string): string {
  if (/login|auth|password|sign|oauth/i.test(text)) return "Auth";
  if (/export|report|csv|dashboard/i.test(text)) return "Reporting";
  if (/api|endpoint|rate|limit|webhook/i.test(text)) return "API";
  if (/test|ci|flak/i.test(text)) return "Quality";
  if (/search|filter|paginat/i.test(text)) return "Search";
  return "Product";
}

function priority(value: unknown, fallback: IntakeDraftProposal["priority"]): IntakeDraftProposal["priority"] {
  return value === "high" || value === "med" || value === "low" ? value : fallback;
}

function size(value: unknown, fallback: IntakeDraftProposal["size"]): IntakeDraftProposal["size"] {
  return value === "S" || value === "M" || value === "L" || value === "XL" ? value : fallback;
}

export function smallerSize(current: Story["size"]): Story["size"] {
  if (current === "XL") return "L";
  if (current === "L") return "M";
  return "S";
}

export function refineTitlePart(title: string, part: number): string {
  return /\(part \d+\)$/i.test(title) ? title.replace(/\(part \d+\)$/i, `(part ${part})`) : `${title} (part ${part})`;
}

// --- model JSON parsing / normalization ------------------------------------

export function parseJsonLike(raw: string): unknown {
  try {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) return JSON.parse(trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed);
    if (trimmed.startsWith("[")) return JSON.parse(trimmed.match(/\[[\s\S]*\]/)?.[0] ?? trimmed);
    const array = raw.match(/\[[\s\S]*\]/);
    if (array) return JSON.parse(array[0]);
    const object = raw.match(/\{[\s\S]*\}/);
    if (object) return JSON.parse(object[0]);
  } catch {
    return null;
  }
  return null;
}

export function normalizeScenario(value: unknown, fallbackName: string): GherkinScenario {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const steps = Array.isArray(v.steps)
    ? v.steps
        .map((step): GherkinScenario["steps"][number] | null => {
          if (!Array.isArray(step) || step.length < 2) return null;
          const kw = String(step[0]);
          if (kw !== "Given" && kw !== "When" && kw !== "Then" && kw !== "And") return null;
          return [kw, String(step[1])];
        })
        .filter((step): step is GherkinScenario["steps"][number] => !!step)
    : ([
        ["Given", String(v.given ?? "the story is ready to refine")],
        ["When", String(v.when ?? "the user performs the refined workflow")],
        ["Then", String(v.then ?? "the expected outcome is observable")],
        ...(v.and ? ([["And", String(v.and)]] as GherkinScenario["steps"]) : []),
      ] as GherkinScenario["steps"]);
  return {
    name: cap(String(v.name ?? fallbackName)),
    steps: steps.length > 0 ? steps : [["Then", fallbackName]],
  };
}

export function normalizeScenarios(value: unknown, fallbacks: string[]): GherkinScenario[] {
  const arr = Array.isArray(value) ? value : [];
  const scenarios = arr.map((item, i) => normalizeScenario(item, fallbacks[i] ?? `Scenario ${i + 1}`));
  return scenarios.length > 0
    ? scenarios.slice(0, 4)
    : fallbacks.slice(0, 4).map((name) => normalizeScenario({ name }, name));
}

export function criteriaFromScenarios(scenarios: GherkinScenario[]): string[] {
  return scenarios.map((scenario) => scenario.name);
}

export function fallbackTightenedScenarios(story: Story): GherkinScenario[] {
  const seeds = (story.criteria.length ? story.criteria : [story.title]).slice(0, 4);
  return seeds.map((criterion, i) => ({
    name: cap(criterion),
    steps: [
      ["Given", `the user is working with ${story.wid}`],
      ["When", `they complete ${criterion.toLowerCase()}`],
      ["Then", `the UI shows a verifiable result for ${criterion.toLowerCase()}`],
      ...(i === 0 ? ([ ["And", "no existing queue behavior regresses"] ] as GherkinScenario["steps"]) : []),
    ],
  }));
}

function storyText(story: Story): string {
  return [story.title, story.description, ...story.criteria, ...(story.scenarios?.map((s) => s.name) ?? [])]
    .join(" ")
    .toLowerCase();
}

export function bestDeterministicOverlap(story: Story, siblings: Story[]): { story: Story; score: number } | null {
  const title = story.title.trim().toLowerCase();
  const words = new Set(storyText(story).split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  let best: { story: Story; score: number } | null = null;
  for (const sibling of siblings) {
    const siblingTitle = sibling.title.trim().toLowerCase();
    let score = title && siblingTitle && title === siblingTitle ? 1 : 0;
    const siblingWords = new Set(storyText(sibling).split(/[^a-z0-9]+/).filter((w) => w.length > 3));
    const shared = [...words].filter((w) => siblingWords.has(w)).length;
    const total = new Set([...words, ...siblingWords]).size || 1;
    score = Math.max(score, shared / total);
    if (score >= 0.34 && (!best || score > best.score)) best = { story: sibling, score };
  }
  return best;
}

// --- proposal builders -----------------------------------------------------

export function fallbackDraftProposals(kind: IntakeKind, text: string): IntakeDraftProposal[] {
  if (kind === "bug") {
    const title = cap(text || "A screen shows an error instead of the expected content").slice(0, 72);
    const severity = /crash|data loss|down|security|outage/i.test(title) ? "S1" : /broken|fail|error|throw|500|blank/i.test(title) ? "S2" : "S3";
    const area = /api|backend|webhook|endpoint/i.test(title) ? "api" : "app";
    return [{
      include: true,
      type: "bug",
      title,
      priority: severity === "S1" || severity === "S2" ? "high" : "med",
      size: "M",
      summary: `Investigate ${area} symptom and confirm the root cause before patching.`,
      description: `Symptom: ${title}`,
      epic: guessEpic(title),
      taskClass: "bugfix",
      tags: ["intake", "bug"],
      criteria: ["Reported behavior is reproducible", "Root cause is documented", "Fix is covered by a regression check"],
      bug: {
        severity,
        area,
        steps: ["Navigate to the affected screen", "Perform the reported action", "Observe the incorrect result"],
        rootCause: `src/${area}/${slug(title).slice(0, 16)}.ts:142 — suspected unhandled edge case; re-confirm before patching`,
        fixOptions: ["Guard the failing path and render a safe result (recommended)", "Fix upstream so the invalid state cannot occur"],
      },
    }];
  }

  const defaults = kind === "prd"
    ? ["Public rate-limit tracer bullet", "Read-path for the new report", "Write-path and persistence", "UI surface with empty state"]
    : ["Let users sign in with Google", "Export activity as CSV", "Add empty states to the dashboard"];

  return linesFromText(text, defaults).map((line, i) => {
    const title = cap(line);
    const isSlice = kind === "prd";
    const isBugish = /fix|bug|broken|error/i.test(line);
    return {
      include: true,
      type: isSlice ? "slice" : "story",
      title,
      priority: i === 0 ? "high" : i === 1 ? "med" : "low",
      size: line.length > 64 ? "L" : line.length > 34 ? "M" : "S",
      summary: isSlice ? `Ship an end-to-end tracer bullet for ${title.toLowerCase()}.` : `As a user, I want ${title.charAt(0).toLowerCase() + title.slice(1)} so that the workflow improves.`,
      description: isSlice ? `Vertical slice through the stack for ${title}.` : `As a user, I want ${title.charAt(0).toLowerCase() + title.slice(1)} so that the product better fits my workflow.`,
      epic: guessEpic(line),
      taskClass: isBugish ? "bugfix" : "feature",
      tags: ["intake", guessEpic(line)],
      criteria: isSlice
        ? [`End-to-end path works for ${title.toLowerCase()}`, "Covered by a focused test", "Demoable on its own"]
        : [`${title} works end to end`, "No existing behavior regresses"],
      slice: isSlice ? { afk: i === 0, blockedBy: i === 0 ? null : `slice ${i}`, userStoriesCovered: `story ${i + 1}` } : undefined,
    } satisfies IntakeDraftProposal;
  });
}

export function normalizeModelDrafts(kind: IntakeKind, parsed: unknown): IntakeDraftProposal[] {
  const arr = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).slice(0, kind === "bug" ? 1 : 4) as Array<Record<string, unknown>>;
  return arr.map((d, i) => {
    const title = cap(String(d.title ?? (kind === "bug" ? "Bug" : kind === "prd" ? "Slice" : "Story")));
    if (kind === "bug") {
      const severity = ["S1", "S2", "S3", "S4"].includes(String(d.severity)) ? String(d.severity) as "S1" | "S2" | "S3" | "S4" : "S3";
      const area = String(d.area ?? "app");
      return {
        include: true,
        type: "bug",
        title,
        priority: priority(d.priority ?? d.prio, severity === "S1" || severity === "S2" ? "high" : "med"),
        size: size(d.size, "M"),
        summary: String(d.summary ?? d.context ?? `Fix ${title.toLowerCase()}.`),
        description: String(d.description ?? d.context ?? title),
        epic: String(d.epic ?? guessEpic(title)),
        taskClass: "bugfix",
        tags: ["intake", "bug"],
        criteria: Array.isArray(d.acceptance) ? d.acceptance.map(String) : ["Regression is fixed"],
        bug: {
          severity,
          area,
          steps: Array.isArray(d.steps) ? d.steps.map(String) : ["Reproduce the reported action"],
          rootCause: String(d.rootCause ?? "to be confirmed by arc-bug-fixer"),
          fixOptions: Array.isArray(d.fixOptions) ? d.fixOptions.map(String) : ["Investigate and patch at the source"],
        },
      };
    }

    const isSlice = kind === "prd";
    return {
      include: true,
      type: isSlice ? "slice" : "story",
      title,
      priority: priority(d.priority ?? d.prio, i === 0 ? "high" : "med"),
      size: size(d.size, "M"),
      summary: String(d.summary ?? d.userStory ?? d.userStoriesCovered ?? d.context ?? title),
      description: String(d.description ?? d.userStory ?? d.context ?? title),
      epic: String(d.epic ?? guessEpic(title)),
      taskClass: String(d.taskClass) === "bugfix" ? "bugfix" : "feature",
      tags: ["intake", String(d.epic ?? guessEpic(title))],
      criteria: Array.isArray(d.acceptance) ? d.acceptance.map(String) : Array.isArray(d.criteria) ? d.criteria.map(String) : ["Works end to end"],
      slice: isSlice ? {
        afk: d.afk !== false,
        blockedBy: d.blockedBy && String(d.blockedBy).toLowerCase() !== "null" ? String(d.blockedBy) : null,
        userStoriesCovered: String(d.userStoriesCovered ?? `story ${i + 1}`),
      } : undefined,
    } satisfies IntakeDraftProposal;
  });
}

export function storyProposalFromPart(story: Story, part: Record<string, unknown>, fallbackTitle: string): IntakeDraftProposal {
  const title = cap(String(part.title ?? fallbackTitle));
  const scenarios = normalizeScenarios(part.scenarios, [title]);
  return {
    include: true,
    type: story.type,
    title,
    priority: story.priority,
    size: smallerSize(story.size),
    summary: String(part.summary ?? part.userStory ?? part.description ?? `Refined child story for ${story.title}.`),
    description: String(part.userStory ?? part.description ?? story.description),
    epic: story.epic,
    taskClass: story.taskClass,
    tags: story.tags,
    criteria: criteriaFromScenarios(scenarios),
    scenarios,
    bug: story.type === "bug" ? story.bug : undefined,
    slice: story.type === "slice" ? story.slice : undefined,
  };
}

// --- prompt construction (owned by the pipeline, not the board) ------------

const EXPLORE_SYSTEM =
  "You are codex-explore, a read-only repository analyst. Output ONLY JSON: {\"note\":\"one short line naming what was scanned\",\"files\":[\"path\", up to 5]}.";

const DRAFT_PROMPTS: Record<IntakeKind, { system: string; body: string }> = {
  feature: {
    system:
      "You are the arc-creating-user-stories drafting agent. Convert feature requests into up to 4 independently deliverable Gherkin user stories. Output ONLY a JSON array of objects with title, epic, prio, size, userStory, acceptance, and summary.",
    body: "Let users sign in with Google\nExport activity as CSV\nAdd empty states to the dashboard",
  },
  prd: {
    system:
      "You are the arc-prd-to-issues drafting agent. Slice this PRD into up to 4 independently shippable tracer-bullet issues. Output ONLY a JSON array with title, epic, prio, size, afk, blockedBy, acceptance, userStoriesCovered, and summary.",
    body: "A dashboard showing per-user activity with CSV export and a rate-limited public API.",
  },
  bug: {
    system:
      "You are the arc-bug-finder drafting agent. Draft ONE root-caused bug ticket. Output ONLY a JSON object with title, severity, area, steps, rootCause, fixOptions, acceptance, and summary.",
    body: "A screen shows a blank error instead of the expected content",
  },
};

const DRAFT_BODY_LABEL: Record<IntakeKind, string> = {
  feature: "Features",
  prd: "PRD",
  bug: "Symptom",
};

const SPLIT_SYSTEM =
  "You split an over-large user story into exactly 2 smaller, independently deliverable Gherkin stories. Output ONLY a JSON array of exactly 2 objects with title, userStory, summary, and scenarios [{name,given,when,then,and?}].";

const TIGHTEN_SYSTEM =
  "You rewrite acceptance criteria to be crisper and more testable. Output ONLY a JSON array of scenario objects: {name,given,when,then,and?}. Keep the same intent; make each step observable and specific.";

const DEDUPE_SYSTEM =
  "You check whether a candidate story duplicates any existing sibling story. Output ONLY JSON: {\"duplicate\":true|false,\"of\":\"matching issue or story\",\"reason\":\"one sentence\"}. Do not delete anything.";

// --- model-backed orchestration (model stays in the injected session) ------

/**
 * Intake request → proposal. Runs the injected model (explore + draft prompts)
 * when a session and project are attached, then normalizes to
 * `IntakeDraftProposal[]`. Falls back to the deterministic proposals — same
 * shape — whenever the model is unavailable or errors.
 */
export async function generateDraftProposals(
  deps: IntakePipelineDeps,
  args: { kind: IntakeKind; text: string }
): Promise<IntakeGenerateResult> {
  const text = args.text.trim();
  const { modelComplete: model, project } = deps;

  if (model && project) {
    try {
      const exploreRaw = await model({
        system: EXPLORE_SYSTEM,
        max_tokens: 400,
        messages: [{ role: "user", content: `Repo: ${project.repo}\nRequest:\n${text || "(use sensible defaults)"}` }],
      });
      const explored = parseJsonLike(exploreRaw) as { note?: string; files?: string[] } | null;
      const files = Array.isArray(explored?.files) ? explored.files.slice(0, 5) : [];
      const exploreNote = explored?.note
        ? `${explored.note}${files.length ? ` · ${files.slice(0, 3).join(", ")}` : ""}`
        : files.length ? `scanned ${files.slice(0, 3).join(", ")}` : "";
      const spec = DRAFT_PROMPTS[args.kind];
      const body = `${DRAFT_BODY_LABEL[args.kind]}:\n${text || spec.body}`;
      const draftRaw = await model({
        system: spec.system,
        max_tokens: 2000,
        messages: [{ role: "user", content: `${body}${files.length ? `\n\nGround items in these files where relevant: ${files.join(", ")}` : ""}` }],
      });
      const drafts = normalizeModelDrafts(args.kind, parseJsonLike(draftRaw));
      if (drafts.length) return { source: "model", exploreNote, drafts };
    } catch {
      // Fall through to deterministic proposals when the live harness cannot answer.
    }
  }

  return {
    source: "fallback",
    exploreNote: model && !project ? "Attach a Fable session to enable model-backed drafting" : "deterministic fallback used",
    drafts: fallbackDraftProposals(args.kind, text),
  };
}

export interface SplitPlan {
  source: IntakeDraftSource;
  note: string;
  story: Story;
  child: IntakeDraftProposal;
}

/** Deterministic split of an over-large story into part 1 + a part 2 proposal. */
export function fallbackSplit(story: Story): { story: Story; child: IntakeDraftProposal } {
  const criteria = story.criteria.length ? story.criteria : [`${story.title} works end to end`, "No existing behavior regresses"];
  const midpoint = Math.max(1, Math.ceil(criteria.length / 2));
  const firstCriteria = criteria.slice(0, midpoint);
  const secondCriteria = criteria.slice(midpoint);
  const childCriteria = secondCriteria.length ? secondCriteria : [`${story.title} follow-up path works end to end`];
  return {
    story: {
      ...story,
      title: refineTitlePart(story.title, 1),
      size: smallerSize(story.size),
      criteria: firstCriteria,
      scenarios: fallbackTightenedScenarios({ ...story, criteria: firstCriteria }),
    },
    child: {
      include: true,
      type: story.type,
      title: refineTitlePart(story.title, 2),
      priority: story.priority,
      size: smallerSize(story.size),
      summary: `Deterministic split-out child story for ${story.title}.`,
      description: story.description,
      epic: story.epic,
      taskClass: story.taskClass,
      tags: story.tags,
      criteria: childCriteria,
      scenarios: fallbackTightenedScenarios({ ...story, title: refineTitlePart(story.title, 2), criteria: childCriteria }),
      bug: story.type === "bug" ? story.bug : undefined,
      slice: story.type === "slice" ? story.slice : undefined,
    },
  };
}

/** Plan a split: model when available, deterministic fallback otherwise. */
export async function planSplit(deps: IntakePipelineDeps, story: Story): Promise<SplitPlan> {
  const split = fallbackSplit(story);
  let source: IntakeDraftSource = "fallback";
  let note = "Fallback used: split into deterministic part 1 and part 2 drafts.";

  if (deps.modelComplete && deps.project) {
    try {
      const raw = await deps.modelComplete({
        system: SPLIT_SYSTEM,
        max_tokens: 1200,
        messages: [{ role: "user", content: `Story: ${story.title}\n${story.description}\nCriteria: ${JSON.stringify(story.criteria)}` }],
      });
      const parsed = parseJsonLike(raw);
      const arr = Array.isArray(parsed) ? parsed : [];
      if (arr.length >= 2) {
        const first = (arr[0] && typeof arr[0] === "object" ? arr[0] : {}) as Record<string, unknown>;
        const firstTitle = cap(String(first.title ?? refineTitlePart(story.title, 1)));
        const firstScenarios = normalizeScenarios(first.scenarios, [firstTitle]);
        return {
          source: "model",
          note: "Model split this story into two smaller drafts.",
          story: {
            ...story,
            title: firstTitle,
            description: String(first.userStory ?? first.description ?? story.description),
            size: smallerSize(story.size),
            criteria: criteriaFromScenarios(firstScenarios),
            scenarios: firstScenarios,
          },
          child: storyProposalFromPart(story, arr[1] as Record<string, unknown>, refineTitlePart(story.title, 2)),
        };
      }
    } catch {
      source = "fallback";
    }
  }

  return { source, note, story: split.story, child: split.child };
}

export interface TightenPlan {
  source: IntakeDraftSource;
  note: string;
  scenarios: GherkinScenario[];
}

/** Plan a tighten: model when available, deterministic Gherkin fallback otherwise. */
export async function planTighten(deps: IntakePipelineDeps, story: Story): Promise<TightenPlan> {
  let scenarios = fallbackTightenedScenarios(story);
  let source: IntakeDraftSource = "fallback";
  let note = "Fallback used: criteria were converted into deterministic Given/When/Then scenarios.";

  if (deps.modelComplete && deps.project) {
    try {
      const raw = await deps.modelComplete({
        system: TIGHTEN_SYSTEM,
        max_tokens: 1000,
        messages: [{ role: "user", content: `Story: ${story.title}\nCurrent: ${JSON.stringify([...(story.scenarios?.map((s) => s.name) ?? []), ...story.criteria])}` }],
      });
      const parsed = parseJsonLike(raw);
      const arr = Array.isArray(parsed) ? parsed : [];
      if (arr.length > 0) {
        scenarios = normalizeScenarios(arr, story.criteria.length ? story.criteria : [story.title]);
        source = "model";
        note = "Model tightened the acceptance criteria into testable scenarios.";
      }
    } catch {
      source = "fallback";
    }
  }

  return { source, note, scenarios };
}

export interface DedupePlan {
  source: IntakeDraftSource;
  note: string;
}

/** Plan a dedupe check: never deletes; reports overlaps only. */
export async function planDedupe(deps: IntakePipelineDeps, story: Story, siblings: Story[]): Promise<DedupePlan> {
  let source: IntakeDraftSource = "fallback";
  let note = "";

  if (deps.modelComplete && deps.project) {
    try {
      const existing = siblings.map((s) => `${s.issue ?? s.wid} ${s.title}`).join("\n");
      const raw = await deps.modelComplete({
        system: DEDUPE_SYSTEM,
        max_tokens: 300,
        messages: [{ role: "user", content: `Candidate: ${story.title}\n${story.description}\nExisting:\n${existing}` }],
      });
      const parsed = parseJsonLike(raw);
      const obj = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | null;
      if (obj) {
        source = "model";
        note = obj.duplicate
          ? `Possible duplicate of ${String(obj.of ?? "an existing story")}${obj.reason ? ` — ${String(obj.reason)}` : ""}. Nothing was deleted.`
          : `No duplicate found${obj.reason ? ` — ${String(obj.reason)}` : ""}. Nothing was deleted.`;
      }
    } catch {
      source = "fallback";
    }
  }

  if (source === "fallback") {
    const overlap = bestDeterministicOverlap(story, siblings);
    note = overlap
      ? `Fallback used: possible overlap with ${overlap.story.issue ?? overlap.story.wid} “${overlap.story.title}” (${Math.round(overlap.score * 100)}% title/content similarity). Nothing was deleted.`
      : "Fallback used: no exact or high-similarity sibling overlap found. Nothing was deleted.";
  }

  return { source, note };
}
