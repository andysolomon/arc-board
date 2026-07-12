/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardStore, routeColor } from "../src/lib/boardStore";
import { activityRoute, ObservabilityView } from "../src/components/ObservabilityView";

describe("ObservabilityView monitor broadcast", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("lists the latest 20 notifications newest first with route-colored markers", async () => {
    const store = new BoardStore("http://127.0.0.1:9/mcp");

    for (let i = 0; i < 22; i++) {
      store.notify("info", `filler-${i}`, {
        icon: "•",
        subject: "Fable",
        text: `event ${i}`,
        tone: "started",
      });
    }
    store.notify("info", "queued story", {
      icon: "➕",
      subject: "Queue",
      text: "queued W-000001",
      tone: "queued",
    });
    store.notify("info", "planning story", {
      icon: "◌",
      subject: "Planner",
      text: "analyzing W-000002",
      tone: "planning",
    });
    store.notify("info", "started story", {
      icon: "◈",
      subject: "Fable",
      text: "started W-000003",
      tone: "started",
    });

    await act(async () => {
      root.render(<ObservabilityView store={store} />);
    });

    const items = container.querySelectorAll("[data-testid^='monitor-broadcast-item-']");
    expect(items).toHaveLength(20);

    const first = container.querySelector("[data-testid^='monitor-broadcast-item-'] .sq-route__dot") as HTMLElement;
    expect(first.getAttribute("data-route")).toBe("fable");
    expect(first.style.background).toBe(routeColor("fable"));

    const routes = [...container.querySelectorAll(".sq-route__dot")].map((dot) =>
      dot.getAttribute("data-route"),
    );
    expect(routes[0]).toBe("fable");
    expect(routes).toContain("composer-implement");
    expect(routes).toContain("opus-explore");

    const labels = [...items].map((item) => item.querySelector(".sq-runrow__label")?.textContent?.trim());
    expect(labels[0]).toContain("started W-000003");
    expect(labels[1]).toContain("analyzing W-000002");
    expect(labels[2]).toContain("queued W-000001");
    expect(labels[3]).toContain("event 21");
  });

  it("updates live when the store emits a new notification without remounting", async () => {
    const store = new BoardStore("http://127.0.0.1:9/mcp");

    await act(async () => {
      root.render(<ObservabilityView store={store} />);
    });

    expect(container.querySelector("[data-testid='monitor-broadcast-empty']")).not.toBeNull();

    await act(async () => {
      store.notify("info", "Live event arrived", {
        icon: "◈",
        subject: "Fable",
        text: "started W-000099",
        tone: "started",
      });
    });

    expect(container.querySelector("[data-testid='monitor-broadcast-empty']")).toBeNull();
    expect(container.textContent).toContain("started W-000099");
    expect(container.querySelectorAll("[data-testid^='monitor-broadcast-item-']")).toHaveLength(1);
  });

  it("renders an explicit empty state when there are no notifications", async () => {
    const store = new BoardStore("http://127.0.0.1:9/mcp");

    await act(async () => {
      root.render(<ObservabilityView store={store} />);
    });

    const empty = container.querySelector("[data-testid='monitor-broadcast-empty']");
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain("No broadcast events yet");
    expect(container.querySelectorAll("[data-testid^='monitor-broadcast-item-']")).toHaveLength(0);
  });
});

describe("activityRoute", () => {
  it("maps activity subjects to orchestration routes", () => {
    expect(
      activityRoute({
        id: "1",
        message: "m",
        ts: 0,
        read: false,
        icon: "•",
        subject: "Queue",
        text: "",
        tone: "queued",
      }),
    ).toBe("composer-implement");
    expect(
      activityRoute({
        id: "2",
        message: "m",
        ts: 0,
        read: false,
        icon: "•",
        subject: "Planner",
        text: "",
        tone: "planning",
      }),
    ).toBe("opus-explore");
    expect(
      activityRoute({
        id: "3",
        message: "m",
        ts: 0,
        read: false,
        icon: "•",
        subject: "Fable",
        text: "",
        tone: "started",
      }),
    ).toBe("fable");
  });
});
