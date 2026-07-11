import type { ReviewVerdict, Story } from "arc-contracts";

function verdictVariant(verdict: ReviewVerdict): string {
  switch (verdict) {
    case "approved":
      return "sq-pr-readiness__chip--pass";
    case "changes_requested":
      return "sq-pr-readiness__chip--fail";
    default:
      return "sq-pr-readiness__chip--pending";
  }
}

function verdictLabel(verdict: ReviewVerdict): string {
  switch (verdict) {
    case "changes_requested":
      return "changes requested";
    case "approved":
      return "approved";
    default:
      return "pending";
  }
}

interface ReviewRoundsStripProps {
  story: Story;
}

export function ReviewRoundsStrip({ story }: ReviewRoundsStripProps) {
  const loop = story.reviewLoop;
  if (!loop) return null;

  return (
    <section className="sq-drawer__section sq-pr-readiness" data-testid="review-rounds-strip">
      <div className="sq-block__label sq-block__label--row">
        <span>Review rounds</span>
      </div>
      <div className="sq-pr-readiness__chips">
        <span
          className="sq-pr-readiness__chip sq-pr-readiness__chip--status sq-pr-readiness__chip--unknown"
          data-testid="review-rounds-round"
        >
          round {loop.round}/{loop.maxRounds}
        </span>
        <span
          className={`sq-pr-readiness__chip sq-pr-readiness__chip--status ${verdictVariant(loop.verdict)}`}
          data-testid="review-rounds-verdict"
        >
          {verdictLabel(loop.verdict)}
        </span>
        {loop.blockingCount > 0 && (
          <span
            className="sq-pr-readiness__chip sq-pr-readiness__chip--fail"
            data-testid="review-rounds-blocking"
          >
            {loop.blockingCount} blocking
          </span>
        )}
      </div>
      {loop.prCommentsUrl && (
        <a
          href={loop.prCommentsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="sq-pr-readiness__link"
          data-testid="review-rounds-comments-link"
        >
          View PR review comments ↗
        </a>
      )}
    </section>
  );
}

export function reviewLoopBlockReason(story: Story): string | null {
  const loop = story.reviewLoop;
  if (!loop || loop.verdict === "approved") return null;
  return `review round ${loop.round}/${loop.maxRounds} — ${verdictLabel(loop.verdict)}`;
}
