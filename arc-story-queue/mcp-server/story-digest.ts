import { createHash } from "node:crypto";
import type { Story } from "arc-contracts";

/** Plan-relevant fields only — excludes column, queue order, orchestration, and tags. */
export function storyDigestPayload(story: Story): {
  title: string;
  description: string;
  criteria: string[];
  plan: { tasks: string[]; files: Array<{ path: string; change: string }>; testStrategy: string } | null;
} {
  const plan = story.plan;
  return {
    title: story.title,
    description: story.description,
    criteria: story.criteria,
    plan: plan
      ? { tasks: plan.tasks, files: plan.files, testStrategy: plan.testStrategy }
      : null,
  };
}

export function storyDigest(story: Story): string {
  return createHash("sha256").update(JSON.stringify(storyDigestPayload(story))).digest("hex");
}
