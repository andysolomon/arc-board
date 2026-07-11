import { useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Column } from "arc-contracts";
import type { BoardStore } from "../lib/boardStore";
import { useAsyncAction } from "../lib/useAsyncAction";
import { AsyncButton } from "./AsyncButton";
import { BOARD_COLUMNS } from "../lib/boardStore";
import {
  pointerDropTargetFromPoint,
  queueOrderWithInsertion,
  type PointerDropTarget,
} from "../lib/pointerDnd";
import { BoardColumn } from "./BoardColumn";

interface BoardViewProps {
  store: BoardStore;
  onOpen?: (id: string) => void;
}

// Columns whose cards can be dragged, and the legal drop transitions.
const DRAGGABLE: Column[] = ["backlog", "queued", "in_progress"];

export function BoardView({ store, onOpen }: BoardViewProps) {
  const { busy: importBusy, run: runImport } = useAsyncAction();
  const [actionError, setActionError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragCol, setDragCol] = useState<Column | null>(null);
  const [dropCol, setDropCol] = useState<Column | null>(null);
  const [dropBeforeId, setDropBeforeId] = useState<string | null>(null);
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
    if (target === "review" && dragCol === "in_progress") return true; // send to review
    return false;
  }

  function endDrag() {
    setDragId(null);
    setDragCol(null);
    setDropCol(null);
    setDropBeforeId(null);
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

  function updatePointerTarget(clientX: number, clientY: number) {
    if (!dragId) return;
    const target = pointerDropTargetFromPoint(clientX, clientY, dragId);
    if (target && isDroppable(target.column)) {
      setDropCol(target.column);
      setDropBeforeId(target.beforeId);
    } else {
      setDropCol(null);
      setDropBeforeId(null);
    }
  }

  async function handlePointerDrop(target: PointerDropTarget | null) {
    const id = dragId;
    const from = dragCol;
    endDrag();
    if (!id || !from || !target || !isDroppable(target.column)) return;

    if (target.column === "queued") {
      if (from === "backlog") {
        await runTransition(async () => {
          await store.enqueueStory(id);
          if (target.beforeId) {
            const order = queueOrderWithInsertion(
              store.queueStories().map((s) => s.id),
              id,
              target.beforeId
            );
            await store.reorderQueueTo(order);
          }
        });
      } else if (from === "queued") {
        const order = queueOrderWithInsertion(
          store.queueStories().map((s) => s.id),
          id,
          target.beforeId
        );
        await runTransition(() => store.reorderQueueTo(order));
      }
    } else if (target.column === "backlog" && from === "queued") {
      await runTransition(() => store.unqueueStory(id));
    } else if (target.column === "review" && from === "in_progress") {
      await runTransition(() => store.reviewStory(id));
    }
  }

  function handlePointerDragStart(
    id: string,
    column: Column,
    event: ReactPointerEvent<HTMLElement>
  ) {
    if (event.button !== 0) return;
    event.stopPropagation();
    setDragId(id);
    setDragCol(column);
    setDropCol(null);
    setDropBeforeId(null);
    updatePointerTarget(event.clientX, event.clientY);
  }

  useEffect(() => {
    if (!dragId) return;
    const activeDragId = dragId;

    function onPointerMove(event: PointerEvent) {
      event.preventDefault();
      updatePointerTarget(event.clientX, event.clientY);
    }

    function onPointerUp(event: PointerEvent) {
      event.preventDefault();
      void handlePointerDrop(pointerDropTargetFromPoint(event.clientX, event.clientY, activeDragId));
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [dragId, dragCol]);

  return (
    <div className="sq-view sq-view--board">
      <header className="sq-view__head">
        <div>
          <h1 className="sq-view__title">Board</h1>
          <p className="sq-view__sub">
            {state.activeProjectId === "all"
              ? `All projects · ${state.projects.length} attached`
              : state.project
                ? state.project.repo
                : "No project attached"}
          </p>
        </div>
        {state.project && (
          <AsyncButton
            type="button"
            className="btn btn--secondary"
            busy={importBusy}
            onClick={() =>
              runImport(() => runTransition(() => store.importIssues(state.project!.repo)))
            }
          >
            Import from GitHub
          </AsyncButton>
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
          const inProgress = store.storiesByColumn("in_progress");
          return (
            <BoardColumn
              key={column}
              column={column}
              boardConnected={state.status === "connected"}
              stories={column === "queued" ? store.queueStories() : store.storiesByColumn(column)}
              inProgressStories={column === "queued" ? inProgress : undefined}
              emptyHint=""
              onEnqueue={column === "backlog" ? handleEnqueue : undefined}
              onOpen={onOpen}
              draggableCards={draggable}
              isDropTarget={dropCol === column && isDroppable(column)}
              draggingId={dragId}
              insertionBeforeId={dropCol === column && column === "queued" ? dropBeforeId : undefined}
              showInsertionMarker={dropCol === column && column === "queued" && isDroppable(column)}
              onCardPointerDragStart={(id, event) => handlePointerDragStart(id, column, event)}
            />
          );
        })}
      </div>
    </div>
  );
}
