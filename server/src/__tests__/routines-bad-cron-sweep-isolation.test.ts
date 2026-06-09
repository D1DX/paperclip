import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecretVersions,
  companySecrets,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issueInboxArchives,
  issueReadStates,
  issues,
  projectWorkspaces,
  projects,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { routineService } from "../services/routines.ts";

// D-1890 regression guard. A single due schedule trigger that throws while being
// processed (e.g. a bad cron expression that nextCronTickInTimeZone rejects) must
// NOT abort the whole tickScheduledTriggers sweep — the per-row try/catch logs and
// skips it so every OTHER due trigger that tick still fires. The original freeze
// re-threw every tick, permanently stalling all triggers.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres bad-cron sweep-isolation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine scheduler — bad-cron sweep isolation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bad-cron-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueInboxArchives);
    await db.delete(issueReadStates);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRoutineFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Routines",
      status: "in_progress",
    });

    const svc = routineService(db, {
      heartbeat: {
        wakeup: async (wakeupAgentId, wakeupOpts) => {
          const issueId =
            (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
            (typeof wakeupOpts.contextSnapshot?.issueId === "string" &&
              wakeupOpts.contextSnapshot.issueId) ||
            null;
          if (!issueId) return null;
          const queuedRunId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: queuedRunId,
            companyId,
            agentId: wakeupAgentId,
            invocationSource: wakeupOpts.source ?? "assignment",
            triggerDetail: wakeupOpts.triggerDetail ?? null,
            status: "queued",
            contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
          });
          await db
            .update(issues)
            .set({ executionRunId: queuedRunId, executionLockedAt: new Date() })
            .where(eq(issues.id, issueId));
          return { id: queuedRunId };
        },
      },
    });

    async function makeRoutine(title: string) {
      return svc.create(
        companyId,
        {
          projectId,
          goalId: null,
          parentIssueId: null,
          title,
          description: `Run the ${title} routine`,
          assigneeAgentId: agentId,
          priority: "medium",
          status: "active",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
        },
        {},
      );
    }

    return { companyId, agentId, projectId, svc, makeRoutine };
  }

  async function insertScheduleTrigger(input: {
    companyId: string;
    routineId: string;
    cronExpression: string;
    timezone: string;
    nextRunAt: Date;
  }) {
    const id = randomUUID();
    await db.insert(routineTriggers).values({
      id,
      companyId: input.companyId,
      routineId: input.routineId,
      kind: "schedule",
      enabled: true,
      cronExpression: input.cronExpression,
      timezone: input.timezone,
      nextRunAt: input.nextRunAt,
    });
    return id;
  }

  it("skips a throwing bad-cron trigger and still fires the other due triggers", async () => {
    const { companyId, svc, makeRoutine } = await seedRoutineFixture();
    const badRoutine = await makeRoutine("bad-cron routine");
    const goodRoutine = await makeRoutine("good-cron routine");

    const now = new Date("2026-06-06T05:00:00.000Z");
    // Bad trigger sorts FIRST (earlier next_run_at) so the good one is processed
    // strictly AFTER the throw — proving the sweep continued past it.
    const badNextRunAt = new Date("2026-06-06T04:50:00.000Z");
    const goodNextRunAt = new Date("2026-06-06T04:55:00.000Z");

    const badTriggerId = await insertScheduleTrigger({
      companyId,
      routineId: badRoutine.id,
      cronExpression: "not-a-valid-cron-expression",
      timezone: "UTC",
      nextRunAt: badNextRunAt,
    });
    const goodTriggerId = await insertScheduleTrigger({
      companyId,
      routineId: goodRoutine.id,
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      nextRunAt: goodNextRunAt,
    });

    const result = await svc.tickScheduledTriggers(now);

    // The good trigger fired despite the bad one throwing first.
    expect(result.triggered).toBe(1);

    const badTrigger = await db
      .select({ nextRunAt: routineTriggers.nextRunAt })
      .from(routineTriggers)
      .where(eq(routineTriggers.id, badTriggerId))
      .then((rows) => rows[0] ?? null);
    const goodTrigger = await db
      .select({ nextRunAt: routineTriggers.nextRunAt })
      .from(routineTriggers)
      .where(eq(routineTriggers.id, goodTriggerId))
      .then((rows) => rows[0] ?? null);

    // Bad trigger was skipped (threw before its claim) — next_run_at unchanged, still due.
    expect(badTrigger?.nextRunAt?.toISOString()).toBe(badNextRunAt.toISOString());
    // Good trigger advanced to its next cron tick (claim succeeded → sweep proceeded).
    expect(goodTrigger?.nextRunAt).toBeTruthy();
    expect(goodTrigger?.nextRunAt!.getTime()).toBeGreaterThan(goodNextRunAt.getTime());
  });
});
