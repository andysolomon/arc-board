import { useEffect } from "react";
import type { BoardStore, Toast } from "../lib/boardStore";

function ToastItem({ toast, store }: { toast: Toast; store: BoardStore }) {
  useEffect(() => {
    const t = setTimeout(() => store.dismissToast(toast.id), 2600);
    return () => clearTimeout(t);
  }, [toast.id, store]);

  return (
    <div className={`sq-toast sq-toast--${toast.kind}`} role="status">
      <span className="sq-toast__dot" />
      <span className="sq-toast__msg">{toast.message}</span>
    </div>
  );
}

export function ToastHost({ store }: { store: BoardStore }) {
  const toasts = store.getToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="sq-toasts" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} store={store} />
      ))}
    </div>
  );
}
