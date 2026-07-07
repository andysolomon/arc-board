import type { BoardStory } from "../lib/boardStore";
import { priorityColor, routeColor, routeLabel } from "../lib/boardStore";

interface StoryCardProps {
  story: BoardStory;
  queueIndex?: number;
  onEnqueue?: (id: string) => void;
  onOpen?: (id: string) => void;
  onDragStart?: (id: string) => void;
  onDropBefore?: (id: string) => void;
  onDragEnd?: () => void;
  dragging?: boolean;
}

export function StoryCard({
  story,
  queueIndex,
  onEnqueue,
  onOpen,
  onDragStart,
  onDropBefore,
  onDragEnd,
  dragging,
}: StoryCardProps) {
  const running = story.column === "in_progress";
  const lastLine = story.lines.length > 0 ? story.lines[story.lines.length - 1] : null;
  const activeRoute = story.activeRoute ?? lastLine?.route ?? "composer-implement";
  const draggable = !!onDragStart;

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
      draggable={draggable}
      onDragStart={
        onDragStart
          ? (e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", story.id);
              onDragStart(story.id);
            }
          : undefined
      }
      onDragEnd={onDragEnd}
      onDragOver={onDropBefore ? (e) => e.preventDefault() : undefined}
      onDrop={
        onDropBefore
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onDropBefore(story.id);
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
