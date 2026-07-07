import { describe, expect, it } from "vitest";
import { BoardStore } from "../src/lib/boardStore";

describe("notifications + toasts (store logic)", () => {
  it("notify pushes a toast and an unread notification", () => {
    const store = new BoardStore("http://127.0.0.1:9/mcp");
    store.notify("success", "queued a");
    store.notify("error", "boom");

    expect(store.getToasts().map((t) => t.message)).toEqual(["queued a", "boom"]);
    // notifications are newest-first
    expect(store.getNotifications().map((n) => n.message)).toEqual(["boom", "queued a"]);
    expect(store.getActivityItems().map((a) => a.subject)).toEqual(["boom", "queued a"]);
    expect(store.unreadCount()).toBe(2);
  });

  it("notify can attach structured activity metadata for the timeline", () => {
    const store = new BoardStore("http://127.0.0.1:9/mcp");
    store.notify("info", "Queued W-000001 — Story A", {
      icon: "➕",
      subject: "Queue",
      text: "queued W-000001 — “Story A”",
      tone: "queued",
    });

    expect(store.getActivityItems()[0]).toMatchObject({
      icon: "➕",
      subject: "Queue",
      text: "queued W-000001 — “Story A”",
      tone: "queued",
    });
  });

  it("dismissToast removes only the toast, leaving the notification", () => {
    const store = new BoardStore("http://127.0.0.1:9/mcp");
    store.notify("info", "one");
    const id = store.getToasts()[0].id;
    store.dismissToast(id);
    expect(store.getToasts()).toHaveLength(0);
    expect(store.getNotifications()).toHaveLength(1);
  });

  it("markNotificationsRead clears the unread count", () => {
    const store = new BoardStore("http://127.0.0.1:9/mcp");
    store.notify("info", "one");
    store.notify("info", "two");
    expect(store.unreadCount()).toBe(2);
    store.markNotificationsRead();
    expect(store.unreadCount()).toBe(0);
    expect(store.getNotifications()).toHaveLength(2);
  });

  it("caps the notification history at 50, newest first", () => {
    const store = new BoardStore("http://127.0.0.1:9/mcp");
    for (let i = 0; i < 60; i++) store.notify("info", `n${i}`);
    const notes = store.getNotifications();
    expect(notes).toHaveLength(50);
    expect(notes[0].message).toBe("n59");
  });
});
