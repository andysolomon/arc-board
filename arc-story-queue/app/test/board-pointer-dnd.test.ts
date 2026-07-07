/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pointerDropTargetFromPoint, queueOrderWithInsertion } from "../src/lib/pointerDnd";

function rect(top: number, height = 30): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 240,
    width: 240,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function makeColumn(column: string, ids: string[]): HTMLElement {
  const section = document.createElement("section");
  section.dataset.column = column;

  ids.forEach((id, i) => {
    const card = document.createElement("article");
    card.dataset.storyId = id;
    Object.defineProperty(card, "getBoundingClientRect", {
      configurable: true,
      value: () => rect(10 + i * 40),
    });
    const title = document.createElement("span");
    title.textContent = id;
    card.appendChild(title);
    section.appendChild(card);
  });

  document.body.appendChild(section);
  return section;
}

describe("pointer board drag helpers", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("computes queue reorder insertion before a target card or at the end", () => {
    expect(queueOrderWithInsertion(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(queueOrderWithInsertion(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
  });

  it("resolves queued insertion targets from pointer coordinates without HTML5 DnD", () => {
    const queued = makeColumn("queued", ["a", "b", "c"]);
    const childInsideQueuedCard = queued.querySelector("[data-story-id='b'] span")!;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => childInsideQueuedCard),
    });

    expect(pointerDropTargetFromPoint(20, 80, "a")).toEqual({ column: "queued", beforeId: "c" });
    expect(pointerDropTargetFromPoint(20, 160, "a")).toEqual({ column: "queued", beforeId: null });
  });

  it("does not calculate insertion ids for non-queue droppable columns", () => {
    const backlog = makeColumn("backlog", ["draft"]);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => backlog),
    });

    expect(pointerDropTargetFromPoint(20, 20, "q1")).toEqual({ column: "backlog", beforeId: null });
  });
});
