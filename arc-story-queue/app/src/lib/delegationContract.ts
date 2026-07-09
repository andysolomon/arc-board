import type { Story } from "arc-contracts";

export interface ContractRow {
  label: string;
  slug: string;
  color: string;
  value: string;
}

/**
 * Build the five Delegation-contract rows with prototype-accurate accent colors.
 * Pure so the label→color map and value derivations stay unit-testable in the
 * node test env (no JSX / React import).
 */
export function buildContractRows(story: Story): ContractRow[] {
  const invariants = [story.issue ? `Preserve GitHub link ${story.issue}` : null, ...story.criteria]
    .filter(Boolean)
    .slice(0, 3)
    .join(" · ");
  const verification = story.plan?.testStrategy || story.criteria[0] || "Verify the accepted behavior before handoff.";
  return [
    { label: "Outcome", slug: "outcome", color: "#3ecf8e", value: story.description || story.title },
    {
      label: "Scope",
      slug: "scope",
      color: "#7c9cff",
      value: [story.repo, story.branch, story.worktree].filter(Boolean).join(" · ") || "Story-scoped repository changes only",
    },
    {
      label: "Invariants",
      slug: "invariants",
      color: "#c084fc",
      value: invariants || "No unrelated queue, board, or daemon behavior regresses.",
    },
    { label: "Verification", slug: "verification", color: "#f5b544", value: verification },
    {
      label: "Prohibited",
      slug: "prohibited",
      color: "#f87171",
      value: "No unrelated rewrites, hidden empty sections, or overflow-prone drawer content.",
    },
  ];
}
