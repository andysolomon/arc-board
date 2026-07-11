import type { BoardActionError, Story } from "arc-contracts";
import { formatBoardActionError } from "../lib/boardActionError";

const WARN_CODES = new Set(["checks_failed", "branch_policy", "behind_base", "timeout"]);
const REMEDIATION_CODES = ["checks_failed", "branch_policy", "behind_base", "unknown"] as const;
type MergeRemediationCode = (typeof REMEDIATION_CODES)[number];
const remediationCodeSet: ReadonlySet<BoardActionError["code"]> = new Set(REMEDIATION_CODES);

export function canRemediateMerge(code: BoardActionError["code"]): code is MergeRemediationCode {
  return remediationCodeSet.has(code);
}

function calloutVariant(code: BoardActionError["code"]): "info" | "warn" | "danger" {
  if (code === "checks_pending") return "info";
  if (WARN_CODES.has(code)) return "warn";
  return "danger";
}

function isRealPrUrl(pr?: string | null): pr is string {
  return !!pr && !pr.startsWith("local://") && /^https?:\/\//i.test(pr);
}

interface MergeBlockedCalloutProps {
  error: BoardActionError;
  story: Story;
  onRetry?: () => void;
  onFixWithComposer?: (code: "checks_failed" | "branch_policy" | "behind_base" | "unknown") => void;
}

export function MergeBlockedCallout({ error, story, onRetry, onFixWithComposer }: MergeBlockedCalloutProps) {
  const formatted = formatBoardActionError(error);
  const variant = calloutVariant(error.code);
  const remediationCode = canRemediateMerge(error.code) ? error.code : null;

  return (
    <div className={`sq-merge-callout sq-merge-callout--${variant}`} role="alert">
      <div className="sq-merge-callout__title">{formatted.title}</div>
      {formatted.actions.length > 0 && (
        <ul className="sq-merge-callout__bullets">
          {formatted.actions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ul>
      )}
      <div className="sq-merge-callout__actions">
        {isRealPrUrl(story.pr) && (
          <a
            href={story.pr}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn--secondary"
          >
            Open PR on GitHub ↗
          </a>
        )}
        {error.retryable === true && onRetry && (
          <button type="button" className="btn btn--secondary" onClick={onRetry}>
            Retry merge
          </button>
        )}
        {remediationCode && onFixWithComposer && (
          <button type="button" className="btn btn--secondary" onClick={() => onFixWithComposer(remediationCode)}>
            Fix with Composer
          </button>
        )}
      </div>
      {formatted.technicalDetail && (
        <details className="sq-merge-callout__details">
          <summary>Technical details</summary>
          <pre className="sq-handoff-json sq-scroll">{formatted.technicalDetail}</pre>
        </details>
      )}
    </div>
  );
}
