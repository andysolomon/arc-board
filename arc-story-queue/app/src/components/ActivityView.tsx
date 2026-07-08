import { useEffect, useState } from "react";
import type { BoardStore } from "../lib/boardStore";

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function formatRelativeTime(ts: number, now = Date.now()): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return "just now";
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  if (abs < 604_800_000) return rtf.format(Math.round(diff / 86_400_000), "day");
  return rtf.format(Math.round(diff / 604_800_000), "week");
}

function toneClass(tone: string): string {
  return tone.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

interface ActivityViewProps {
  store: BoardStore;
}

export function ActivityView({ store }: ActivityViewProps) {
  const [now, setNow] = useState(() => Date.now());
  const activity = store.getActivityItems();

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="sq-view sq-activity-view">
      <header className="sq-view__head">
        <div>
          <h1 className="sq-view__title">Activity</h1>
          <p className="sq-view__sub">A live timeline of queue, filing, review, and Fable lifecycle events.</p>
        </div>
      </header>

      <div className="sq-activity" role="list" aria-label="Pipeline activity timeline">
        {activity.length === 0 && <div className="sq-empty">No activity yet. Lifecycle events will appear here as they arrive.</div>}
        {activity.map((item, index) => (
          <div key={item.id} className="sq-activity__item" role="listitem">
            <div className="sq-activity__rail" aria-hidden>
              <span className={`sq-activity__icon sq-activity__icon--${toneClass(item.tone)}`}>
                {item.icon}
              </span>
              {index < activity.length - 1 && <span className="sq-activity__line" />}
            </div>
            <div className="sq-activity__body">
              <div className="sq-activity__copy">
                <span className="sq-activity__subject">{item.subject}</span>
                {item.text && <span> {item.text}</span>}
              </div>
              <time
                className="sq-activity__time"
                dateTime={new Date(item.ts).toISOString()}
                title={new Date(item.ts).toLocaleString()}
              >
                {formatRelativeTime(item.ts, now)}
              </time>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
