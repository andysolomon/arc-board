import type { BoardStory, TerminalLine } from "./boardStore";

export function formatIssueBadge(issue?: string | null): string | null {
  const raw = issue?.trim();
  if (!raw) return null;
  const match = raw.match(/(?:issues\/|#)(\d+)/i) ?? raw.match(/\b(\d+)\b/);
  return match ? `⊙ ${match[1]}` : null;
}

export function formatPrLabel(pr?: string | null): string | null {
  const raw = pr?.trim();
  if (!raw) return null;
  const match = raw.match(/(?:pull\/|PR\s*#|#)(\d+)/i) ?? raw.match(/\b(\d+)\b/);
  return match ? `PR #${match[1]}` : null;
}

export function annotationLabel(annotation: NonNullable<BoardStory["annotation"]>): string {
  if (annotation === "accepted") return "✓ accepted";
  if (annotation === "escalated") return "↥ escalated";
  return annotation.replace(/-/g, " ");
}

export function formatTerminalLine(line: TerminalLine): string {
  const prefix = line.kind === "cmd" ? "$ " : line.kind === "lock" || line.kind === "unlock" ? "⚿ " : "";
  return `${prefix}${line.text}`;
}
