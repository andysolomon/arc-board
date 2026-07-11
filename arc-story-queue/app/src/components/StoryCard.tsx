import type { PointerEvent as ReactPointerEvent } from "react";
import type { BoardStory } from "../lib/boardStore";
import { useAsyncAction } from "../lib/useAsyncAction";
import { AsyncButton } from "./AsyncButton";
import {
  hasLiveWorker,
  priorityColor,
  routeAccess,
  routeColor,
  routeLabel,
  workerLanes,
} from "../lib/boardStore";
import {
  annotationLabel,
  formatIssueBadge,
  formatPrLabel,
  formatTerminalLine,
} from "../lib/storyCardFormat";
import { planBadge } from "../lib/orchestrationPlan";

interface StoryCardProps {
  story: BoardStory;
  queueIndex?: number;
  waitReason?: string | null;
  onEnqueue?: (id: string) => void;
  onOpen?: (id: string) => void;
  onPointerDragStart?: (id: string, event: ReactPointerEvent<HTMLElement>) => void;
  dragging?: boolean;
}

export function StoryCard({
  story,
  queueIndex,
  waitReason,
  onEnqueue,
  onOpen,
  onPointerDragStart,
  dragging,
}: StoryCardProps) {
  const { busy: enqueueBusy, run: runEnqueue } = useAsyncAction();
  const running = story.column === "in_progress";
  const liveWorkerStream = hasLiveWorker(story);
  const lastLine = story.lines.length > 0 ? story.lines[story.lines.length - 1] : null;
  const activeRoute = story.activeRoute ?? lastLine?.route ?? "composer-implement";
  const lanes = workerLanes(story);
  const readOnlyCount = lanes.filter((lane) => routeAccess(lane.route) === "read-only").length;
  const issueBadge = formatIssueBadge(story.issue);
  const prLabel = formatPrLabel(story.pr);
  const prColor = story.prState === "merged" ? "#c084fc" : "#3ecf8e";
  const annotation = story.annotation ? annotationLabel(story.annotation) : null;
  const bugBadge =
    story.type === "bug" ? `BUG${story.bug?.severity ? ` · ${story.bug.severity}` : ""}` : null;
  const terminalLine = lastLine ? formatTerminalLine(lastLine) : "dispatching…";
  const plan = story.column === "queued" ? planBadge(story) : null;
  const reviewLoop =
    story.column === "review" && story.reviewLoop && story.reviewLoop.verdict !== "approved"
      ? story.reviewLoop
      : null;
  const reviewLoopIndicator = reviewLoop
    ? reviewLoop.round === 0
      ? "↻ awaiting"
      : `↻ ${reviewLoop.round}/${reviewLoop.maxRounds}`
    : null;
  const reviewLoopA11yLabel = reviewLoop
    ? reviewLoop.round === 0
      ? "awaiting review"
      : `review round ${reviewLoop.round} of ${reviewLoop.maxRounds}`
    : null;
  const draggable = !!onPointerDragStart;

  return (
    <article
      className={`story-card${running ? " story-card--running" : ""}${onOpen ? " story-card--clickable" : ""}${draggable ? " story-card--draggable" : ""}${dragging ? " story-card--dragging" : ""}`}
      data-story-id={story.id}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen ? () => onOpen(story.id) : undefined}
      onKeyDown={
        onOpen
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(story.id);
              }
            }
          : undefined
      }
      onPointerDown={
        onPointerDragStart
          ? (e) => {
              const target = e.target as HTMLElement;
              if (target.closest("button,a,input,textarea,select")) return;
              onPointerDragStart(story.id, e);
            }
          : undefined
      }
    >
      <div className="story-card__body">
        <span
          className="story-card__prio"
          style={{ background: priorityColor(story.priority) }}
          aria-hidden
        />
        <div className="story-card__content">
          <div className="story-card__badges">
            {queueIndex !== undefined && (
              <span className="story-card__qbadge">#{queueIndex + 1}</span>
            )}
            {issueBadge && <span className="story-card__issue">{issueBadge}</span>}
            {prLabel && (
              <span className="story-card__pr" style={{ color: prColor }}>
                {prLabel}
              </span>
            )}
            {annotation && (
              <span
                className={`story-card__annotation story-card__annotation--${story.annotation}`}
              >
                {annotation}
              </span>
            )}
            {bugBadge && <span className="story-card__bug">{bugBadge}</span>}
            {story.draft && <span className="story-card__draft">DRAFT</span>}
            {plan && (
              <span className={`story-card__plan story-card__plan--${plan.slug}`}>
                {plan.label}
              </span>
            )}
            {reviewLoopIndicator && reviewLoopA11yLabel && (
              <span
                className="story-card__review-loop"
                data-testid="review-loop-indicator"
                title={reviewLoopA11yLabel}
                aria-label={reviewLoopA11yLabel}
              >
                {reviewLoopIndicator}
              </span>
            )}
          </div>
          <h3 className="story-card__title">{story.title}</h3>

          {running ? (
            liveWorkerStream ? (
              <>
                <div className="story-card__route-row">
                  <span className="story-card__route" style={{ color: routeColor(activeRoute) }}>
                    <span
                      className="story-card__route-dot"
                      style={{ background: routeColor(activeRoute) }}
                    />
                    {routeLabel(activeRoute)}
                  </span>
                  <span className="story-card__lock story-card__lock--write">⚿ write</span>
                  <span className="story-card__lock story-card__lock--read">
                    ⇉ {readOnlyCount} read-only
                  </span>
                </div>
                {story.worktree && <div className="story-card__worktree">⌥ {story.worktree}</div>}
                <div className="story-card__terminal" title={terminalLine}>
                  {terminalLine}
                  <span
                    className="story-card__caret"
                    style={{ color: routeColor(activeRoute) }}
                    aria-hidden
                  >
                    ▊
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="story-card__reserved">reserved · awaiting worker</div>
                {story.worktree && <div className="story-card__worktree">⌥ {story.worktree}</div>}
              </>
            )
          ) : (
            <>
              <div className="story-card__meta" title={`${story.wid} ⎇ ${story.branch}`}>
                <span className="story-card__wid">{story.wid}</span>
                <span className="story-card__branch">⎇ {story.branch}</span>
              </div>
              {waitReason && <div className="story-card__waiting">{waitReason}</div>}
              {story.tags.length > 0 && (
                <div className="story-card__tags">
                  {story.tags.map((tag) => (
                    <span key={tag} className="story-card__tag">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              {onEnqueue && (
                <AsyncButton
                  type="button"
                  className="story-card__enqueue"
                  busy={enqueueBusy}
                  data-testid={`enqueue-${story.id}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => runEnqueue(() => Promise.resolve(onEnqueue(story.id)))}
                >
                  Enqueue →
                </AsyncButton>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}
