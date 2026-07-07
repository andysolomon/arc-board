import { useState } from "react";
import type { Column } from "arc-contracts";
import type { BoardStore } from "../lib/boardStore";
import { BOARD_COLUMNS } from "../lib/boardStore";
import { BoardColumn } from "./BoardColumn";

interface BoardViewProps {
  store: BoardStore;
  onOpen?: (id: string) => void;
}

// Columns whose cards can be dragged, and the legal drop transitions.
const DRAGGABLE: Column[] = ["backlog", "queued"];

export function BoardView({ store, onOpen }: BoardViewProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragCol, setDragCol] = useState<Column | null>(null);
  const [dropCol, setDropCol] = useState<Column | null>(null);
  const state = store.getState();

  async function handleEnqueue(id: string) {
    setActionError(null);
    try {
      await store.enqueueStory(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionError(msg);
      store.notify("error", msg);
    }
  }

  function isDroppable(target: Column): boolean {
    if (!dragCol) return false;
    if (target === "queued" && dragCol === "queued") return true; // reorder
    if (target === "queued" && dragCol === "backlog") return true; // enqueue (guardrail)
    if (target === "backlog" && dragCol === "queued") return true; // unqueue
    return false;
  }

  function endDrag() {
    setDragId(null);
    setDragCol(null);
    setDropCol(null);
  }

  async function runTransition(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionError(msg);
      store.notify("error", msg);
    }
  }

  async function handleColumnDrop(target: Column) {
    const id = dragId;
    const from = dragCol;
    endDrag();
    if (!id || !from || target === from) {
      if (target === "queued" && from === "queued") {
        // dropped on empty queued area → move to end
        const order = store.queueStories().map((s) => s.id).filter((x) => x !== id);
        if (id) order.push(id);
        await runTransition(() => store.reorderQueueTo(order));
      }
      return;
    }
    if (target === "queued" && from === "backlog") await runTransition(() => store.enqueueStory(id));
    else if (target === "backlog" && from === "queued") await runTransition(() => store.unqueueStory(id));
  }

  async function handleCardDropBefore(beforeId: string, column: Column) {
    const id = dragId;
    const from = dragCol;
    if (column === "queued" && from === "queued" && id && id !== beforeId) {
      endDrag();
      const order = store.queueStories().map((s) => s.id).filter((x) => x !== id);
      const idx = order.indexOf(beforeId);
      order.splice(idx < 0 ? order.length : idx, 0, id);
      await runTransition(() => store.reorderQueueTo(order));
      return;
    }
    // dropping onto a card in another column behaves like a column drop
    await handleColumnDrop(column);
  }

  return (
    <div className="sq-view">
      <header className="sq-view__head">
        <div>
          <h1 className="sq-view__title">Board</h1>
          <p className="sq-view__sub">
            {state.project ? state.project.repo : "No project attached"}
          </p>
        </div>
        {state.project && (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => void runTransition(() => store.importIssues(state.project!.repo))}
          >
            Import from GitHub
          </button>
        )}
      </header>
      {(actionError || (!state.project && state.error)) && (
        <span className="connect-bar__error board-view__enqueue-error">
          {actionError ?? state.error}
        </span>
      )}
      <div className="board-view__columns">
        {BOARD_COLUMNS.map((column) => {
          const draggable = DRAGGABLE.includes(column);
          return (
            <BoardColumn
              key={column}
              column={column}
              stories={store.storiesByColumn(column)}
              emptyHint=""
              onEnqueue={column === "backlog" ? handleEnqueue : undefined}
              onOpen={onOpen}
              draggableCards={draggable}
              isDropTarget={dropCol === column && isDroppable(column)}
              draggingId={dragId}
              onCardDragStart={(id) => {
                setDragId(id);
                setDragCol(column);
              }}
              onCardDropBefore={(beforeId) => void handleCardDropBefore(beforeId, column)}
              onCardDragEnd={endDrag}
              onColumnDragOver={() => setDropCol(isDroppable(column) ? column : null)}
              onColumnDragLeave={() => setDropCol((c) => (c === column ? null : c))}
              onColumnDrop={() => void handleColumnDrop(column)}
            />
          );
        })}
      </div>
    </div>
  );
}
