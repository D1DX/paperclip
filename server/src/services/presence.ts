import { and, eq, gt, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { operatorPresence } from "@paperclipai/db";

/**
 * A presence row counts as "live" only while its `lastSeenAt` is within this
 * window (D-1155). The PostToolUse hook heartbeats faster than this, so a
 * stopped session goes dark within ~one TTL of its last tool call.
 */
export const OPERATOR_PRESENCE_TTL_MS = 120_000;

function presenceFreshnessThreshold(): Date {
  return new Date(Date.now() - OPERATOR_PRESENCE_TTL_MS);
}

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

/**
 * Issue ids with at least one fresh operator-presence row (company-scoped).
 * This is the parallel liveness feed the UI unions into `collectLiveIssueIds`
 * so the existing blue "Live" issue pill fires for operator-paced agents,
 * which have no heartbeat runs (D-1155).
 */
export async function listLivePresenceIssueIds(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .select({ issueId: operatorPresence.issueId })
    .from(operatorPresence)
    .where(
      and(
        eq(operatorPresence.companyId, companyId),
        isNotNull(operatorPresence.issueId),
        gt(operatorPresence.lastSeenAt, presenceFreshnessThreshold()),
      ),
    );
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.issueId) ids.add(row.issueId);
  }
  return [...ids];
}

/**
 * Agent ids with at least one fresh operator-presence row (company-scoped).
 * Used to derive `isLive` for the agent list payload in one query.
 */
export async function listLiveAgentIds(db: Db, companyId: string): Promise<Set<string>> {
  const rows = await db
    .select({ agentId: operatorPresence.agentId })
    .from(operatorPresence)
    .where(
      and(
        eq(operatorPresence.companyId, companyId),
        gt(operatorPresence.lastSeenAt, presenceFreshnessThreshold()),
      ),
    );
  return new Set(rows.map((row) => row.agentId));
}

/** True if the given agent has at least one fresh operator-presence row. */
export async function isOperatorAgentLive(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: operatorPresence.id })
    .from(operatorPresence)
    .where(
      and(
        eq(operatorPresence.companyId, companyId),
        eq(operatorPresence.agentId, agentId),
        gt(operatorPresence.lastSeenAt, presenceFreshnessThreshold()),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
