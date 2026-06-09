import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

// D-1890 regression guard. A stranded assigned issue whose ONLY "active path" is a
// STALE orphaned `deferred_issue_execution` wake (older than the freshness floor —
// the run it was parked behind is gone) must NOT be treated as live. Stranded
// recovery supersedes the orphan (marks it failed) and re-dispatches a fresh wake,
// so the orphan cannot later be spuriously promoted into a duplicate run.
// Exercises reconcileStrandedAssignedIssues -> supersedeStaleOrphanedDeferredWakes.

const STRANDED_DEFERRED_WAKE_MAX_AGE_MS = 2 * 60 * 1000;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stranded-recovery orphaned-deferred-wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

describeEmbeddedPostgres("stranded recovery — stale orphaned deferred wake", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stranded-orphan-wake-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("supersedes a stale orphaned deferred wake and re-dispatches a fresh wake", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stranded todo with only a stale orphaned deferred wake",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    // The only "path" is a deferred wake older than the freshness floor — orphaned.
    const staleWakeId = randomUUID();
    const staleRequestedAt = new Date(Date.now() - STRANDED_DEFERRED_WAKE_MAX_AGE_MS - 60_000);
    await db.insert(agentWakeupRequests).values({
      id: staleWakeId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "deferred_issue_execution",
      requestedByActorType: "system",
      requestedAt: staleRequestedAt,
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    // A fresh assignment dispatch was enqueued for the stranded todo.
    expect(result.assignmentDispatched).toBe(1);
    expect(result.issueIds).toContain(issueId);

    // The stale orphan was superseded (failed), not left to be promoted later.
    const staleWake = await db
      .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, staleWakeId))
      .then((rows) => rows[0] ?? null);
    expect(staleWake?.status).toBe("failed");
    expect(staleWake?.error).toContain("Superseded by stranded recovery");

    // A distinct fresh wake now exists for the issue.
    const freshWakes = await db
      .select({
        id: agentWakeupRequests.id,
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          ne(agentWakeupRequests.id, staleWakeId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
        ),
      );
    expect(freshWakes).toHaveLength(1);
    expect(freshWakes[0]?.status).not.toBe("failed");
    expect(freshWakes[0]?.status).not.toBe("deferred_issue_execution");
    expect((freshWakes[0]?.payload as Record<string, unknown>)?.mutation).toBe(
      "assigned_todo_liveness_dispatch",
    );
  });

  it("leaves a FRESH deferred wake intact (no supersede, no duplicate dispatch)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stranded todo with a still-fresh deferred wake",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const freshWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: freshWakeId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "deferred_issue_execution",
      requestedByActorType: "system",
      requestedAt: new Date(), // fresh — within the freshness floor
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    // Fresh deferred wake counts as a live path → recovery skips, nothing superseded.
    expect(result.assignmentDispatched).toBe(0);
    const freshWake = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, freshWakeId))
      .then((rows) => rows[0] ?? null);
    expect(freshWake?.status).toBe("deferred_issue_execution");
  });
});
