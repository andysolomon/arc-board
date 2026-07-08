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
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Notifications"
        onClick={toggle}
      >
        <svg className="sq-bell__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
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
