import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { BoardStore } from "../src/lib/boardStore";
import { BoardSync } from "../src/lib/boardSync";

function storeSync(store: BoardStore): BoardSync {
  return (store as unknown as { sync: BoardSync }).sync;
}

function handleDisconnect(store: BoardStore): void {
  (store as unknown as { handleDisconnect(): void }).handleDisconnect();
}

describe("board SSE liveness and reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reconnects after an unexpected disconnect and refreshes views on success", async () => {
    const store = new BoardStore("http://127.0.0.1:1/mcp", {
      storage: null,
      liveness: { reconnectDelaysMs: [100], watchdogIntervalMs: 60_000, staleEventThresholdMs: 60_000 },
    });
    const sync = storeSync(store);
    let connected = false;
    const connectSpy = vi.spyOn(sync, "connect").mockImplementation(async () => {
      connected = true;
    });
    vi.spyOn(sync, "isConnected").mockImplementation(() => connected);
    const refreshSpy = vi.spyOn(store, "refreshViews").mockResolvedValue(undefined);

    await store.connect();
    expect(store.getState().status).toBe("connected");

    connected = false;
    handleDisconnect(store);
    expect(store.getState().status).toBe("connecting");

    await vi.advanceTimersByTimeAsync(100);
    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(store.getState().status).toBe("connected");
    expect(refreshSpy).toHaveBeenCalled();
  });

  it("does not reconnect after an explicit store close", async () => {
    const store = new BoardStore("http://127.0.0.1:1/mcp", {
      storage: null,
      liveness: { reconnectDelaysMs: [100], watchdogIntervalMs: 60_000, staleEventThresholdMs: 60_000 },
    });
    const sync = storeSync(store);
    let connected = false;
    const connectSpy = vi.spyOn(sync, "connect").mockImplementation(async () => {
      connected = true;
    });
    vi.spyOn(sync, "isConnected").mockImplementation(() => connected);

    await store.connect();
    await store.close();

    connected = false;
    handleDisconnect(store);
    await vi.advanceTimersByTimeAsync(500);

    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe("disconnected");
  });

  it("watchdog forces reconnect when lastEventAt is stale", async () => {
    const store = new BoardStore("http://127.0.0.1:1/mcp", {
      storage: null,
      liveness: { reconnectDelaysMs: [100], watchdogIntervalMs: 1_000, staleEventThresholdMs: 5_000 },
    });
    const sync = storeSync(store);
    let connected = false;
    const connectSpy = vi.spyOn(sync, "connect").mockImplementation(async () => {
      connected = true;
    });
    vi.spyOn(sync, "isConnected").mockImplementation(() => connected);
    const closeSpy = vi.spyOn(sync, "close").mockImplementation(async () => {
      connected = false;
    });
    vi.spyOn(store, "refreshViews").mockResolvedValue(undefined);

    await store.connect();
    vi.spyOn(sync, "lastEventAt", "get").mockReturnValue(Date.now() - 61_000);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(closeSpy).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(store.getState().status).toBe("connected");
  });

  it("watchdog forces reconnect when lastEventAt is null after connect grace", async () => {
    const store = new BoardStore("http://127.0.0.1:1/mcp", {
      storage: null,
      liveness: { reconnectDelaysMs: [100], watchdogIntervalMs: 1_000, staleEventThresholdMs: 5_000 },
    });
    const sync = storeSync(store);
    let connected = false;
    const connectSpy = vi.spyOn(sync, "connect").mockImplementation(async () => {
      connected = true;
    });
    vi.spyOn(sync, "isConnected").mockImplementation(() => connected);
    const closeSpy = vi.spyOn(sync, "close").mockImplementation(async () => {
      connected = false;
    });
    const refreshSpy = vi.spyOn(store, "refreshViews").mockResolvedValue(undefined);
    vi.spyOn(sync, "lastEventAt", "get").mockReturnValue(null);

    await store.connect();
    expect(store.getState().status).toBe("connected");

    await vi.advanceTimersByTimeAsync(4_999);
    expect(closeSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_001);
    expect(closeSpy).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(store.getState().status).toBe("connected");
    expect(refreshSpy).toHaveBeenCalled();
  });

  it("hydrate removes scoped stories missing from stories.list", async () => {
    const store = new BoardStore("http://127.0.0.1:1/mcp", { storage: null });
    const sync = storeSync(store);
    vi.spyOn(sync, "connect").mockResolvedValue(undefined);
    vi.spyOn(sync, "isConnected").mockReturnValue(true);

    const project = {
      id: "project-hydrate",
      repo: "acme/hydrate",
      path: "/tmp/hydrate",
      branch: "main",
      model: "vitest",
      pid: 1,
      worktreeRoot: "/tmp/wt",
      status: "attached" as const,
    };
    store.e2eHydrate({
      project,
      activeProjectId: project.id,
      projects: [project],
      stories: [
        {
          id: "keep",
          wid: "W-000201",
          type: "story",
          title: "Keep me",
          repo: project.repo,
          branch: "feat/keep",
          worktree: "",
          column: "backlog",
          priority: "med",
          size: "S",
          epic: "",
          taskClass: "feature",
          tags: [],
          description: "",
          criteria: [],
          draft: false,
          issue: "#1",
        },
        {
          id: "orphan",
          wid: "W-000202",
          type: "story",
          title: "Remove me",
          repo: project.repo,
          branch: "feat/orphan",
          worktree: "",
          column: "backlog",
          priority: "med",
          size: "S",
          epic: "",
          taskClass: "feature",
          tags: [],
          description: "",
          criteria: [],
          draft: false,
          issue: "#2",
        },
      ],
    });

    vi.spyOn(sync, "call").mockImplementation(async (tool) => {
      if (tool === "stories.list") {
        return [
          {
            id: "keep",
            wid: "W-000201",
            type: "story",
            title: "Keep me",
            repo: project.repo,
            branch: "feat/keep",
            worktree: "",
            column: "backlog",
            priority: "med",
            size: "S",
            epic: "",
            taskClass: "feature",
            tags: [],
            description: "",
            criteria: [],
            draft: false,
            issue: "#1",
          },
        ];
      }
      throw new Error(`unexpected tool: ${tool}`);
    });

    await store.hydrate();

    const stories = store.getState().stories;
    expect(stories.keep).toBeDefined();
    expect(stories.orphan).toBeUndefined();
  });

  it("ping notifications update lastEventAt without story handlers or view refresh", async () => {
    const onStoryUpdate = vi.fn();
    const onLifecycle = vi.fn();
    const sync = new BoardSync("http://127.0.0.1:1/mcp", null, { onStoryUpdate, onLifecycle });

    let notificationHandler: (notification: unknown) => void = () => undefined;
    vi.spyOn(Client.prototype, "setNotificationHandler").mockImplementation((_schema, handler) => {
      notificationHandler = handler as (notification: unknown) => void;
    });
    vi.spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, "listTools").mockRejectedValue(new Error("no tools/list"));

    await sync.connect();
    expect(sync.lastEventAt).toBeNull();

    notificationHandler({
      params: { data: JSON.stringify({ type: "ping", at: Date.now() }) },
    });
    expect(sync.lastEventAt).not.toBeNull();
    expect(onStoryUpdate).not.toHaveBeenCalled();
    expect(onLifecycle).not.toHaveBeenCalled();

    notificationHandler({
      params: { data: JSON.stringify({ type: "story.update", id: "s1", route: "r1" }) },
    });
    expect(onStoryUpdate).toHaveBeenCalledTimes(1);
  });

  it("focus and visibilitychange trigger a refetch when connected", async () => {
    const focusListeners: Array<() => void> = [];
    const visibilityListeners: Array<() => void> = [];
    const globals = globalThis as typeof globalThis & {
      window?: {
        addEventListener(type: string, listener: () => void): void;
        removeEventListener(type: string, listener: () => void): void;
      };
      document?: {
        visibilityState: string;
        addEventListener(type: string, listener: () => void): void;
        removeEventListener(type: string, listener: () => void): void;
      };
    };
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    globals.window = {
      addEventListener(type, listener) {
        if (type === "focus") focusListeners.push(listener);
      },
      removeEventListener(type, listener) {
        if (type === "focus") {
          const index = focusListeners.indexOf(listener);
          if (index >= 0) focusListeners.splice(index, 1);
        }
      },
    };
    globals.document = {
      visibilityState: "visible",
      addEventListener(type, listener) {
        if (type === "visibilitychange") visibilityListeners.push(listener);
      },
      removeEventListener(type, listener) {
        if (type === "visibilitychange") {
          const index = visibilityListeners.indexOf(listener);
          if (index >= 0) visibilityListeners.splice(index, 1);
        }
      },
    };

    const store = new BoardStore("http://127.0.0.1:1/mcp", {
      storage: null,
      liveness: { reconnectDelaysMs: [100], watchdogIntervalMs: 60_000, staleEventThresholdMs: 60_000 },
    });
    const sync = storeSync(store);
    vi.spyOn(sync, "connect").mockResolvedValue(undefined);
    vi.spyOn(sync, "isConnected").mockReturnValue(true);
    const refreshSpy = vi.spyOn(store, "refreshViews").mockResolvedValue(undefined);

    try {
      await store.connect();
      refreshSpy.mockClear();

      for (const listener of focusListeners) listener();
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      for (const listener of visibilityListeners) listener();
      expect(refreshSpy).toHaveBeenCalledTimes(2);
    } finally {
      await store.close();
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
    }
  });
});
