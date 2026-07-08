import { ROUTE_ORDER, type RouteId } from "arc-contracts";
import type { BoardStory, WorkerLane } from "./boardState";

/** Worker lanes for a story, ordered by the canonical route order. */
export function workerLanes(story: BoardStory): WorkerLane[] {
  return Object.values(story.lanes).sort((a, b) => {
    const ai = ROUTE_ORDER.indexOf(a.route as RouteId);
    const bi = ROUTE_ORDER.indexOf(b.route as RouteId);
    if (ai === -1 && bi === -1) return a.route.localeCompare(b.route);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}
