import type { LifecycleKind, StoryLifecycleEvent } from "./boardState";

export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

export interface ActivityMeta {
  icon: string;
  subject: string;
  text: string;
  tone: string;
}

export interface ActivityItem extends ActivityMeta {
  id: string;
  message: string;
  ts: number;
  read: boolean;
}

export interface AppNotification extends Toast {
  ts: number;
  read: boolean;
  activity: ActivityMeta;
}

export function defaultActivityMeta(kind: ToastKind, message: string): ActivityMeta {
  const icon: Record<ToastKind, string> = {
    info: "•",
    success: "✓",
    error: "!",
  };
  return { icon: icon[kind], subject: message, text: "", tone: kind };
}

function lifecycleActivityLabel(evt: StoryLifecycleEvent): string {
  const title = evt.title ?? evt.id;
  return evt.wid ? `${evt.wid} — “${title}”` : `“${title}”`;
}

export function lifecycleActivityMeta(evt: StoryLifecycleEvent): ActivityMeta {
  const label = lifecycleActivityLabel(evt);
  const map: Record<LifecycleKind, ActivityMeta> = {
    queued: { icon: "➕", subject: "Queue", text: `queued ${label}`, tone: "queued" },
    started: { icon: "◈", subject: "Fable", text: `started ${label}`, tone: "started" },
    review: { icon: "◇", subject: "Fable", text: `moved ${label} to review`, tone: "review" },
    done: { icon: "✓", subject: "Fable", text: `completed ${label}`, tone: "done" },
    abandoned: { icon: "↯", subject: "Fable", text: `abandoned ${label}`, tone: "abandoned" },
    unqueued: { icon: "↩", subject: "Queue", text: `moved ${label} back to backlog`, tone: "unqueued" },
    drafted: { icon: "✎", subject: "Fable", text: `drafted ${label}`, tone: "drafted" },
    "file-requested": { icon: "⇢", subject: "You", text: `asked Fable to file ${label}`, tone: "file-requested" },
    filed: { icon: "⊕", subject: "Fable", text: `filed ${label}`, tone: "filed" },
    merged: { icon: "✓", subject: "You", text: `merged ${label}`, tone: "merged" },
    escalated: { icon: "↥", subject: "Fable", text: `escalated ${label}`, tone: "escalated" },
    purged: { icon: "↯", subject: "Fable", text: `purged ${label} — issue closed`, tone: "abandoned" },
  };
  return map[evt.kind];
}

/** Toast copy for a coarse lifecycle event (SSE-driven board activity). */
export function lifecycleToast(evt: StoryLifecycleEvent): { kind: ToastKind; msg: string } | undefined {
  const label = evt.wid ? `${evt.wid} — ${evt.title ?? evt.id}` : evt.title ?? evt.id;
  const map: Record<LifecycleKind, { kind: ToastKind; msg: string }> = {
    queued: { kind: "info", msg: `Queued ${label}` },
    started: { kind: "info", msg: `Started ${label}` },
    review: { kind: "success", msg: `Review ready: ${label}` },
    done: { kind: "success", msg: `Merged ${label}` },
    abandoned: { kind: "info", msg: `Abandoned ${label}` },
    unqueued: { kind: "info", msg: `Moved ${label} to backlog` },
    drafted: { kind: "success", msg: `Drafted ${label}` },
    "file-requested": { kind: "info", msg: `Filing requested: ${label}` },
    filed: { kind: "success", msg: `Filed ${label}` },
    merged: { kind: "success", msg: `Merged ${label}` },
    escalated: { kind: "info", msg: `Escalated ${label}` },
    purged: { kind: "info", msg: `Purged ${label} — GitHub issue closed` },
  };
  return map[evt.kind];
}

/** Build the transient toast + persistent notification pair for a notify() call. */
export function createNotification(
  id: string,
  kind: ToastKind,
  message: string,
  ts: number,
  activity?: Partial<ActivityMeta>
): { toast: Toast; note: AppNotification } {
  const toast: Toast = { id, kind, message };
  const note: AppNotification = {
    ...toast,
    ts,
    read: false,
    activity: { ...defaultActivityMeta(kind, message), ...activity },
  };
  return { toast, note };
}
