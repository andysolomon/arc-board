import type { BoardActionError } from "arc-contracts";
import { isBoardActionError } from "arc-contracts";

const ARC_ACTION_ERROR_PREFIX = "ARC_ACTION_ERROR:";

export function parseBoardActionError(err: unknown): BoardActionError | null {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : null;
  if (!message) return null;

  if (message.startsWith(ARC_ACTION_ERROR_PREFIX)) {
    try {
      const parsed: unknown = JSON.parse(message.slice(ARC_ACTION_ERROR_PREFIX.length));
      if (isBoardActionError(parsed)) return parsed;
    } catch {
      // fall through
    }
  }

  try {
    const parsed: unknown = JSON.parse(message);
    if (isBoardActionError(parsed)) return parsed;
  } catch {
    // not JSON
  }

  return null;
}

/** Machine-oriented merge readiness strings belong in technical details only. */
export function isMachineDetail(detail: string): boolean {
  return (
    /mergeStateStatus=/i.test(detail) ||
    /failing checks:/i.test(detail) ||
    /pending checks:/i.test(detail) ||
    /gh pr merge failed/i.test(detail)
  );
}

export function formatBoardActionError(error: BoardActionError): {
  title: string;
  actions: string[];
  technicalDetail?: string;
} {
  const technicalDetail =
    error.raw?.trim() ||
    (error.detail.trim() && isMachineDetail(error.detail) ? error.detail.trim() : undefined);

  return {
    title: error.title,
    actions: error.actions,
    technicalDetail,
  };
}
