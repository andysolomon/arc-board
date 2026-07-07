import { randomUUID } from "node:crypto";
import type { IntakeItem, IntakeKind, Story } from "arc-contracts";
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

  /**
   * Deterministic fallback for the no-Fable-session case: template a draft
   * Story from an intake item without invoking a model. Lands in backlog as a
   * draft, where the file/enqueue guardrail takes over.
   */
  draft(id: string, repo: string): Story {
    const item = this.store.getIntake(id);
    if (!item) throw new Error(`Unknown intake item: ${id}`);
    if (item.status === "done") throw new Error("Intake item already drafted");

    const slug =
      item.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "draft";
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
