import { useEffect, useRef, useState } from "react";
import type { PrReadiness, Story } from "arc-contracts";
import type { BoardStore } from "../lib/boardStore";

function isRealPrUrl(pr?: string | null): pr is string {
  return !!pr && !pr.startsWith("local://") && /^https?:\/\//i.test(pr);
}

function statusVariant(status: string): string {
  switch (status) {
    case "CLEAN":
      return "sq-pr-readiness__chip--clean";
    case "BLOCKED":
      return "sq-pr-readiness__chip--blocked";
    case "BEHIND":
      return "sq-pr-readiness__chip--behind";
    default:
      return "sq-pr-readiness__chip--unknown";
  }
}

export interface PrReadinessPollState {
  readiness: PrReadiness | null;
  loaded: boolean;
  stale: boolean;
}

export function usePrReadinessPoll(store: BoardStore, story: Story): PrReadinessPollState {
  const [readiness, setReadiness] = useState<PrReadiness | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [stale, setStale] = useState(false);
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    if (story.column !== "review" || !story.pr) {
      setReadiness(null);
      setLoaded(false);
      setStale(false);
      hasLoadedRef.current = false;
      return;
    }

    let cancelled = false;

    async function fetchReadiness() {
      try {
        const result = await store.prReadiness(story.id);
        if (cancelled) return;
        setReadiness(result);
        setLoaded(true);
        setStale(false);
        hasLoadedRef.current = true;
      } catch {
        if (cancelled) return;
        setStale(hasLoadedRef.current);
      }
    }

    setReadiness(null);
    setLoaded(false);
    setStale(false);
    hasLoadedRef.current = false;

    void fetchReadiness();
    const interval = setInterval(() => void fetchReadiness(), 10_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [store, story.id, story.pr, story.column]);

  return { readiness, loaded, stale };
}

interface PrReadinessStripProps {
  story: Story;
  readiness: PrReadiness | null;
  stale?: boolean;
}

export function PrReadinessStrip({ story, readiness, stale = false }: PrReadinessStripProps) {
  if (!readiness) return null;

  const showPassing =
    readiness.failingChecks.length === 0 && readiness.pendingChecks.length === 0;

  return (
    <section className="sq-drawer__section sq-pr-readiness" data-testid="pr-readiness-strip">
      <div className="sq-block__label sq-block__label--row">
        <span>PR readiness</span>
        {stale && (
          <span className="sq-block__meta sq-pr-readiness__stale" data-testid="pr-readiness-stale">
            stale
          </span>
        )}
      </div>
      <div className="sq-pr-readiness__chips">
        <span
          className={`sq-pr-readiness__chip sq-pr-readiness__chip--status ${statusVariant(readiness.mergeStateStatus)}`}
          data-testid="pr-readiness-status"
        >
          {readiness.mergeStateStatus}
        </span>
        {readiness.failingChecks.map((check) => (
          <span
            key={`fail-${check}`}
            className="sq-pr-readiness__chip sq-pr-readiness__chip--fail"
            data-testid="pr-readiness-fail"
          >
            {check}
          </span>
        ))}
        {readiness.pendingChecks.map((check) => (
          <span
            key={`pending-${check}`}
            className="sq-pr-readiness__chip sq-pr-readiness__chip--pending"
            data-testid="pr-readiness-pending"
          >
            {check}
          </span>
        ))}
        {showPassing && (
          <span
            className="sq-pr-readiness__chip sq-pr-readiness__chip--pass"
            data-testid="pr-readiness-passing"
          >
            checks passing
          </span>
        )}
      </div>
      {isRealPrUrl(story.pr) && (
        <a
          href={story.pr}
          target="_blank"
          rel="noopener noreferrer"
          className="sq-pr-readiness__link"
          data-testid="pr-readiness-link"
        >
          Open PR on GitHub ↗
        </a>
      )}
    </section>
  );
}
