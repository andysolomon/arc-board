import type { BoardActionError } from "arc-contracts";

export const ARC_ACTION_ERROR_PREFIX = "ARC_ACTION_ERROR:";

export interface MergeReadiness {
  mergeStateStatus: string;
  failingChecks: string[];
  pendingChecks: string[];
}

export function sanitizeGhMessage(message: string): string {
  const lines = message.split(/\r?\n/);
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cleaned = trimmed.replace(/\[[A-F0-9:]+\]/g, "").replace(/\s+/g, " ").trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    deduped.push(cleaned);
  }
  return deduped.join("\n");
}

function readinessDetail(readiness: MergeReadiness): string {
  const parts: string[] = [];
  if (readiness.mergeStateStatus) parts.push(`mergeStateStatus=${readiness.mergeStateStatus}`);
  if (readiness.failingChecks.length) parts.push(`failing checks: ${readiness.failingChecks.join(", ")}`);
  if (readiness.pendingChecks.length) parts.push(`pending checks: ${readiness.pendingChecks.join(", ")}`);
  return parts.join("; ");
}

function isCheckExpectedMessage(message: string): boolean {
  return /\bis expected\b/i.test(message);
}

function isCheckFailingMessage(message: string): boolean {
  return /\bis failing\b/i.test(message) || /\bfailing check/i.test(message);
}

function hasMergeGateFailure(readiness?: MergeReadiness, message = ""): boolean {
  if (readiness?.failingChecks.some((name) => /merge gate/i.test(name))) return true;
  const lower = message.toLowerCase();
  return /merge gate/i.test(lower) && isCheckFailingMessage(lower);
}

function mergeGateActions(): string[] {
  return [
    "Open the PR on GitHub and edit the title to use a conventional prefix (feat:, fix:, chore:, etc.)",
    "Or re-open review with an updated story title",
  ];
}

function checksFailedError(detail: string, readiness?: MergeReadiness, raw?: string): BoardActionError {
  const mergeGate = hasMergeGateFailure(readiness, detail);
  const actions = mergeGate
    ? mergeGateActions()
    : ["Fix failing checks on the PR", "Re-run failed checks after pushing fixes"];
  if (readiness?.pendingChecks.length) {
    actions.push("Wait for pending checks to complete");
  }
  return {
    code: "checks_failed",
    title: mergeGate ? "PR title needs a conventional prefix" : "Required checks failed",
    detail,
    actions,
    retryable: mergeGate ? false : true,
    raw,
  };
}

function checksPendingError(detail: string, raw?: string): BoardActionError {
  return {
    code: "checks_pending",
    title: "Checks still running",
    detail,
    actions: ["Wait for CI checks to complete", "Open the PR on GitHub to watch check progress"],
    retryable: true,
    raw,
  };
}

export function boardActionErrorFromMergeFailure(
  message: string,
  readiness?: MergeReadiness
): BoardActionError {
  const raw = sanitizeGhMessage(message);
  const lower = raw.toLowerCase();

  if (readiness?.failingChecks.length) {
    const detail = readinessDetail(readiness) || raw;
    return checksFailedError(detail, readiness, raw);
  }

  if (lower.includes("timed out waiting")) {
    const detail = readiness ? readinessDetail(readiness) || raw : raw;
    return {
      code: "timeout",
      title: "Timed out waiting for checks",
      detail,
      actions: ["Wait for CI to finish and retry merge", "Check PR status on GitHub"],
      retryable: true,
      raw,
    };
  }

  if (readiness?.pendingChecks.length && readiness.mergeStateStatus !== "CLEAN") {
    return checksPendingError(readinessDetail(readiness) || raw, raw);
  }

  if (readiness?.mergeStateStatus === "BEHIND") {
    return {
      code: "behind_base",
      title: "PR branch is behind base",
      detail: readinessDetail(readiness) || raw,
      actions: ["Update the PR branch with the latest base branch", "Retry merge after the branch is current"],
      retryable: true,
      raw,
    };
  }

  if (lower.includes("not up to date") || /\bbehind\b/.test(lower)) {
    return {
      code: "behind_base",
      title: "PR branch is behind base",
      detail: raw,
      actions: ["Update the PR branch with the latest base branch", "Retry merge after the branch is current"],
      retryable: true,
      raw,
    };
  }

  if (lower.includes("policy prohibits") || lower.includes("branch policy")) {
    const actions = ["Review branch protection rules on GitHub"];
    if (hasMergeGateFailure(readiness, raw)) {
      actions.push(...mergeGateActions());
    } else {
      actions.push("Fix failing checks or approvals required by policy", "Retry merge once policy requirements are met");
    }
    return {
      code: "branch_policy",
      title: "Branch policy blocked merge",
      detail: raw,
      actions,
      retryable: true,
      raw,
    };
  }

  if (isCheckExpectedMessage(raw)) {
    const detail = readiness ? readinessDetail(readiness) || raw : raw;
    return checksPendingError(detail, raw);
  }

  if (
    lower.includes("required status check") ||
    isCheckFailingMessage(lower) ||
    (/merge gate/i.test(lower) && !isCheckExpectedMessage(raw))
  ) {
    return checksFailedError(raw, readiness, raw);
  }

  if (lower.includes("already") && lower.includes("merged")) {
    return {
      code: "already_merged",
      title: "PR already merged",
      detail: raw,
      actions: ["Refresh the board to sync PR state"],
      retryable: false,
      raw,
    };
  }

  if (lower.includes("pull request is closed") || lower.includes("pr is closed") || lower.includes("was closed")) {
    return {
      code: "pr_closed",
      title: "PR is closed",
      detail: raw,
      actions: ["Re-open the PR on GitHub or move the story back to backlog"],
      retryable: false,
      raw,
    };
  }

  if (lower.includes("graphql")) {
    return {
      code: "graphql",
      title: "Couldn't sync the PR branch",
      detail: raw,
      actions: ["Open the PR on GitHub", "Try merge again"],
      retryable: true,
      raw,
    };
  }

  if (readiness && readiness.mergeStateStatus !== "CLEAN") {
    if (readiness.pendingChecks.length) {
      return checksPendingError(readinessDetail(readiness) || raw, raw);
    }
    return {
      code: "unknown",
      title: "PR not ready to merge",
      detail: readinessDetail(readiness) || raw,
      actions: ["Check PR status on GitHub", "Retry merge once requirements are met"],
      retryable: true,
      raw,
    };
  }

  return {
    code: "unknown",
    title: "Merge failed",
    detail: raw || message,
    actions: ["Check PR status on GitHub", "Retry merge"],
    retryable: true,
    raw: raw || message,
  };
}

export function throwMergeError(error: BoardActionError): never {
  throw new Error(`${ARC_ACTION_ERROR_PREFIX}${JSON.stringify(error)}`);
}
