// What a drop on the board asks before it is sent to the host.
import { type Status } from "../../core/model";
import { type KanbanBoard } from "../../core/views/kanban";

/**
 * A task card that becomes blocked asks why (written as `@blocked`). One moved within Blocked, to
 * another place or lane, keeps the reason it has: its status does not change, so nothing would
 * be written of a new one. Punch items have no reason.
 */
export function asksBlockedReason(
  board: KanbanBoard,
  from: Status | undefined,
  to: Status
): boolean {
  return board === "tasks" && to === "blocked" && from !== "blocked";
}
