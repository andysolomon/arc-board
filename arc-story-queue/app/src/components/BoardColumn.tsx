import { Fragment } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Column } from "arc-contracts";
import { dispatchBlockReason } from "arc-contracts";
import type { BoardStory } from "../lib/boardStore";
import { COLUMN_LABELS, columnDotColor } from "../lib/boardStore";
import { StoryCard } from "./StoryCard";

interface BoardColumnProps {
  column: Column;
  stories: BoardStory[];
  emptyHint: string;
  boardConnected?: boolean;
  onEnqueue?: (id: string) => void;
  onOpen?: (id: string) => void;
  // pointer drag-and-drop
  draggableCards?: boolean;
  isDropTarget?: boolean;
  draggingId?: string | null;
  insertionBeforeId?: string | null;
  showInsertionMarker?: boolean;
  onCardPointerDragStart?: (id: string, event: ReactPointerEvent<HTMLElement>) => void;
  inProgressStories?: BoardStory[];
}

const EMPTY_HINTS: Record<Column, string> = {
  backlog: "Drop ideas or import issues",
  queued: "Nothing queued",
  in_progress: "No worktrees running",
  review: "No open PRs",
  done: "Nothing shipped yet",
};

export function BoardColumn({
  column,
  stories,
  emptyHint,
  boardConnected = false,
  onEnqueue,
  onOpen,
  draggableCards,
  isDropTarget,
  draggingId,
  insertionBeforeId,
  showInsertionMarker,
  onCardPointerDragStart,
  inProgressStories = [],
}: BoardColumnProps) {
  const isQueued = column === "queued";
  const isRunning = column === "in_progress";

  return (
    <section
      className={`board-column${isDropTarget ? " board-column--drop" : ""}`}
      data-column={column}
    >
      <header className="board-column__header">
        <span className="board-column__dot" style={{ background: columnDotColor(column) }} />
        <span className="board-column__label">{COLUMN_LABELS[column]}</span>
        <span className="board-column__count">{stories.length}</span>
        {isQueued && <span className="board-column__chip board-column__chip--queued">In order</span>}
        {boardConnected && isRunning && <span className="board-column__chip board-column__chip--running">Live</span>}
      </header>
      <div className="board-column__cards">
        {stories.map((story, i) => (
          <Fragment key={story.id}>
            {showInsertionMarker && insertionBeforeId === story.id && (
              <div className="board-column__insert-line" aria-hidden />
            )}
            <StoryCard
              story={story}
              queueIndex={isQueued ? i : undefined}
              waitReason={isQueued ? dispatchBlockReason(story, inProgressStories) : null}
              onEnqueue={onEnqueue}
              onOpen={onOpen}
              onPointerDragStart={draggableCards ? onCardPointerDragStart : undefined}
              dragging={draggableCards && draggingId === story.id}
            />
          </Fragment>
        ))}
        {showInsertionMarker && insertionBeforeId === null && (
          <div className="board-column__insert-line" aria-hidden />
        )}
        {stories.length === 0 && (
          <div className="board-column__empty">{emptyHint || EMPTY_HINTS[column]}</div>
        )}
      </div>
    </section>
  );
}
