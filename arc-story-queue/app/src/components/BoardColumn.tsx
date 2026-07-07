import type { Column } from "arc-contracts";
import type { BoardStory } from "../lib/boardStore";
import { COLUMN_LABELS, columnDotColor } from "../lib/boardStore";
import { StoryCard } from "./StoryCard";

interface BoardColumnProps {
  column: Column;
  stories: BoardStory[];
  emptyHint: string;
  onEnqueue?: (id: string) => void;
  onOpen?: (id: string) => void;
  // drag-and-drop
  draggableCards?: boolean;
  isDropTarget?: boolean;
  draggingId?: string | null;
  onCardDragStart?: (id: string) => void;
  onCardDropBefore?: (beforeId: string) => void;
  onCardDragEnd?: () => void;
  onColumnDragOver?: () => void;
  onColumnDragLeave?: () => void;
  onColumnDrop?: () => void;
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
  onEnqueue,
  onOpen,
  draggableCards,
  isDropTarget,
  draggingId,
  onCardDragStart,
  onCardDropBefore,
  onCardDragEnd,
  onColumnDragOver,
  onColumnDragLeave,
  onColumnDrop,
}: BoardColumnProps) {
  const isQueued = column === "queued";
  const isRunning = column === "in_progress";

  return (
    <section
      className={`board-column${isDropTarget ? " board-column--drop" : ""}`}
      data-column={column}
      onDragOver={
        onColumnDragOver
          ? (e) => {
              e.preventDefault();
              onColumnDragOver();
            }
          : undefined
      }
      onDragLeave={onColumnDragLeave ? () => onColumnDragLeave() : undefined}
      onDrop={
        onColumnDrop
          ? (e) => {
              e.preventDefault();
              onColumnDrop();
            }
          : undefined
      }
    >
      <header className="board-column__header">
        <span className="board-column__dot" style={{ background: columnDotColor(column) }} />
        <span className="board-column__label">{COLUMN_LABELS[column]}</span>
        <span className="board-column__count">{stories.length}</span>
        {isQueued && <span className="board-column__chip board-column__chip--queued">In order</span>}
        {isRunning && <span className="board-column__chip board-column__chip--running">Live</span>}
      </header>
      <div className="board-column__cards">
        {stories.map((story, i) => (
          <StoryCard
            key={story.id}
            story={story}
            queueIndex={isQueued ? i : undefined}
            onEnqueue={onEnqueue}
            onOpen={onOpen}
            onDragStart={draggableCards ? onCardDragStart : undefined}
            onDropBefore={draggableCards ? onCardDropBefore : undefined}
            onDragEnd={draggableCards ? onCardDragEnd : undefined}
            dragging={draggableCards && draggingId === story.id}
          />
        ))}
        {stories.length === 0 && (
          <div className="board-column__empty">{emptyHint || EMPTY_HINTS[column]}</div>
        )}
      </div>
    </section>
  );
}
