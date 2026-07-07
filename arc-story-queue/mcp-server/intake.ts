import { randomUUID } from "node:crypto";
import type { IntakeDraftProposal, IntakeItem, IntakeKind, Story } from "arc-contracts";
import type { StoryStore } from "./store.js";
import { validateStory } from "./validate.js";

export interface IntakeDeps {
  store: StoryStore;
}

export class IntakeManager {
  constructor(private deps: IntakeDeps) {}

  private get store() {
    return this.deps.store;
  }

  enqueue(args: { kind: IntakeKind; title: string; description: string }): IntakeItem {
    const item: IntakeItem = {
      id: `intake-${randomUUID()}`,
      kind: args.kind,
      title: args.title,
      description: args.description,
      status: "pending",
    };
    this.store.enqueueIntake(item);
    return item;
  }

  next(): IntakeItem | null {
    return this.store.claimNextIntake();
  }

  complete(id: string, story: Story): Story {
    if (story.draft !== true) {
      throw new Error("intake.complete requires a draft story");
    }

    story.column = "backlog";
    validateStory(story);
    this.store.upsertStory(story);
    this.store.completeIntake(id, story.id);
    return story;
  }

  list(): IntakeItem[] {
    return this.store.listIntake();
  }

  private slug(title: string): string {
    return (
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "draft"
    );
  }

  private storyFromProposal(proposal: IntakeDraftProposal, repo: string): Story {
    const slug = this.slug(proposal.title);
    const story: Story = {
      id: `story-${randomUUID().slice(0, 8)}`,
      wid: this.store.nextWid(),
      type: proposal.type,
      title: proposal.title,
      repo,
      branch: `draft/${slug}`,
      worktree: "",
      column: "backlog",
      priority: proposal.priority,
      size: proposal.size,
      epic: proposal.epic,
      taskClass: proposal.taskClass,
      tags: proposal.tags ?? [],
      description: proposal.description || proposal.summary,
      criteria: proposal.criteria,
      scenarios: proposal.scenarios,
      bug: proposal.bug,
      slice: proposal.slice,
      draft: true,
      issue: null,
    };

    validateStory(story);
    return story;
  }

  createDrafts(proposals: IntakeDraftProposal[], repo: string): Story[] {
    const stories = proposals
      .filter((proposal) => proposal.include)
      .map((proposal) => this.storyFromProposal(proposal, repo));
    for (const story of stories) this.store.upsertStory(story);
    return stories;
  }

  /**
   * Deterministic fallback for the no-Fable-session case: template a draft
   * Story from an intake item without invoking a model. Lands in backlog as a
   * draft, where the file/enqueue guardrail takes over.
   */
  draft(id: string, repo: string): Story {
    const item = this.store.getIntake(id);
    if (!item) throw new Error(`Unknown intake item: ${id}`);
    if (item.status === "done") throw new Error("Intake item already drafted");

    const slug = this.slug(item.title);
    const type = item.kind === "bug" ? "bug" : item.kind === "prd" ? "slice" : "story";

    const story: Story = {
      id: `story-${randomUUID().slice(0, 8)}`,
      wid: this.store.nextWid(),
      type,
      title: item.title,
      repo,
      branch: `draft/${slug}`,
      worktree: "",
      column: "backlog",
      priority: "med",
      size: "M",
      epic: "",
      taskClass: item.kind === "bug" ? "bugfix" : "feature",
      tags: [],
      description: item.description,
      criteria: [],
      draft: true,
      issue: null,
    };

    validateStory(story);
    this.store.upsertStory(story);
    this.store.completeIntake(id, story.id);
    return story;
  }
}
