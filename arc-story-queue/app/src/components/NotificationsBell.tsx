import { useEffect, useState } from "react";
import type { BoardStore } from "../lib/boardStore";

export function NotificationsBell({ store }: { store: BoardStore }) {
  const [open, setOpen] = useState(false);
  const notifications = store.getNotifications();
  const unread = store.unreadCount();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function toggle() {
    setOpen((o) => {
      const next = !o;
      if (next) store.markNotificationsRead();
      return next;
    });
  }

  return (
    <div className="sq-bell">
      <button
        type="button"
        className="sq-bell__btn"
        aria-label={`Activity${unread > 0 ? ` (${unread} unread)` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        Activity
        {unread > 0 && <span className="sq-bell__badge">{unread}</span>}
      </button>
      {open && (
        <>
          <div className="sq-bell__scrim" onClick={() => setOpen(false)} />
          <div className="sq-bell__popover sq-scroll" role="dialog" aria-label="Activity">
            <div className="sq-block__label">Activity</div>
            {notifications.length === 0 && <div className="sq-empty">Nothing yet</div>}
            {notifications.map((n) => (
              <div key={n.id} className={`sq-note sq-note--${n.kind}`}>
                <span className="sq-note__dot" />
                <span className="sq-note__msg">{n.message}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
