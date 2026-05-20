import type { Db } from "@paperclipai/db";
import { operatorPresence } from "@paperclipai/db";

export interface UpsertOperatorPresenceInput {
  companyId: string;
  agentId: string;
  sessionId: string;
  issueId: string | null;
}

/**
 * Upsert a per-session presence heartbeat for an operator-paced agent (D-1155).
 * One row per (companyId, agentId, sessionId); `lastSeenAt` is refreshed on every
 * heartbeat and `issueId` follows whatever the session is currently pinned to.
 * Operator-paced agents have no heartbeat runs, so this is the only liveness
 * signal Paperclip receives for them.
 */
export async function upsertOperatorPresence(db: Db, input: UpsertOperatorPresenceInput) {
  const now = new Date();
  await db
    .insert(operatorPresence)
    .values({
      companyId: input.companyId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      issueId: input.issueId,
      lastSeenAt: now,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [operatorPresence.companyId, operatorPresence.agentId, operatorPresence.sessionId],
      set: {
        issueId: input.issueId,
        lastSeenAt: now,
      },
    });
}
