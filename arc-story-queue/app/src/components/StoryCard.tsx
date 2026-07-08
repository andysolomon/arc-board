import type { PointerEvent as ReactPointerEvent } from "react";
import type { BoardStory } from "../lib/boardStore";
import { hasLiveWorker, priorityColor, routeColor, routeLabel } from "../lib/boardStore";

interface StoryCardProps {
  story: BoardStory;
  queueIndex?: number;
  onEnqueue?: (id: string) => void;
  onOpen?: (id: string) => void;
  onPointerDragStart?: (id: string, event: ReactPointerEvent<HTMLElement>) => void;
  dragging?: boolean;
}

export function StoryCard({
  story,
  queueIndex,
  onEnqueue,
  onOpen,
  onPointerDragStart,
  dragging,
}: StoryCardProps) {
  const running = story.column === "in_progress";
  const liveWorkerStream = hasLiveWorker(story);
  const lastLine = story.lines.length > 0 ? story.lines[story.lines.length - 1] : null;
  const activeRoute = story.activeRoute ?? lastLine?.route ?? "composer-implement";
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
            {story.issue && <span className="story-card__issue">{story.issue}</span>}
            {story.draft && <span className="story-card__draft">DRAFT</span>}
            <span className="story-card__size">{story.size}</span>
            <span className="story-card__priority">{story.priority}</span>
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
                </div>
                {story.worktree && <div className="story-card__worktree">{story.worktree}</div>}
                <div className="story-card__terminal">
                  {story.lines.map((line, i) => (
                    <div key={`${line.text}-${i}`} className="story-card__line sq-stream">
                      {line.text}
                    </div>
                  ))}
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
                {story.worktree && <div className="story-card__worktree">{story.worktree}</div>}
              </>
            )
          ) : (
            <>
              <div className="story-card__meta">
                <span className="story-card__wid">{story.wid}</span>
                <span className="story-card__branch">{story.branch}</span>
              </div>
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
                <button
                  type="button"
                  className="story-card__enqueue"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEnqueue(story.id);
                  }}
                >
                  Enqueue →
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}
