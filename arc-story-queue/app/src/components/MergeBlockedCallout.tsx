import type { BoardActionError, Story } from "arc-contracts";
import { formatBoardActionError } from "../lib/boardActionError";

const WARN_CODES = new Set([
  "checks_failed",
  "checks_pending",
  "branch_policy",
  "behind_base",
  "timeout",
]);

function isRealPrUrl(pr?: string | null): pr is string {
  return !!pr && !pr.startsWith("local://") && /^https?:\/\//i.test(pr);
}

interface MergeBlockedCalloutProps {
  error: BoardActionError;
  story: Story;
  onRetry?: () => void;
}

export function MergeBlockedCallout({ error, story, onRetry }: MergeBlockedCalloutProps) {
  const formatted = formatBoardActionError(error);
  const variant = WARN_CODES.has(error.code) ? "warn" : "danger";

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
