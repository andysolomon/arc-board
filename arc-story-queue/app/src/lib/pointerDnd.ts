import type { Column } from "arc-contracts";
import { BOARD_COLUMNS } from "./boardStore";

export interface PointerDropTarget {
  column: Column;
  beforeId: string | null;
}

export function queueOrderWithInsertion(
  currentIds: string[],
  draggedId: string,
  beforeId: string | null
): string[] {
  const order = currentIds.filter((id) => id !== draggedId);
  const idx = beforeId ? order.indexOf(beforeId) : -1;
  order.splice(idx < 0 ? order.length : idx, 0, draggedId);
  return order;
}

function insertionBeforeId(columnEl: HTMLElement, clientY: number, draggedId: string): string | null {
  const cards = Array.from(columnEl.querySelectorAll<HTMLElement>("[data-story-id]")).filter(
    (card) => card.dataset.storyId && card.dataset.storyId !== draggedId
  );

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return card.dataset.storyId ?? null;
  }

  return null;
}

export function pointerDropTargetFromPoint(
  clientX: number,
  clientY: number,
  draggedId: string,
  doc: Document = document
): PointerDropTarget | null {
  const hit = doc.elementFromPoint(clientX, clientY);
  const columnEl = hit?.closest<HTMLElement>("[data-column]");
  const column = columnEl?.dataset.column as Column | undefined;

  if (!columnEl || !column || !BOARD_COLUMNS.includes(column)) return null;

  return {
    column,
    beforeId: column === "queued" ? insertionBeforeId(columnEl, clientY, draggedId) : null,
  };
}
