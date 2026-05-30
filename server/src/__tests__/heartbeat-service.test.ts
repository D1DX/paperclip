import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  resolveResumeAutoCheckoutSkip,
  shouldAutoCheckoutIssueForWake,
} from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";

// D-1619: regression coverage for the D-1614 first-onboard-only auto-checkout gate
// (heartbeat.ts:executeRun ~6759). The gate's resume-skip decision is extracted into
// `resolveResumeAutoCheckoutSkip`; this suite exercises that real decision function
// plus the real `issuesSvc.checkout` side-effect it controls, against embedded Postgres.
// Cold wake (no prior [session-start]) must still flip todo->in_progress + mint
// checkoutRunId; resume wake (prior [session-start] from same agent) must preserve
// `todo` and leave checkoutRunId null when autoPromoteTodoOnResume=false.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat D-1614 auto-checkout-on-resume gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Parameterized seed (D-1383 precedent): optional adapterType + an optional prior
  // [session-start] author (the resume fixture). Seeds a company, an agent, a project,
  // a `todo` issue assigned to that agent, and a queued heartbeat run to stand in as
  // the checkout run id.
  async function seedFixture(opts?: {
    adapterType?: string;
    priorSessionStartBy?: "same-agent" | "other-agent" | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "LocalCli",
        role: "engineer",
        status: "active",
        adapterType: opts?.adapterType ?? "http",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "OtherAgent",
        role: "engineer",
        status: "active",
        adapterType: "http",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Heartbeat",
      status: "in_progress",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "queued",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Resume gate fixture",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      identifier: `${issuePrefix}-1`,
      issueNumber: 1,
    });

    if (opts?.priorSessionStartBy) {
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: opts.priorSessionStartBy === "same-agent" ? agentId : otherAgentId,
        authorType: "agent",
        body: "[session-start] Started session via /task.",
      });
    }

    const issuesSvc = issueService(db);

    const readIssue = async () =>
      db
        .select({ status: issues.status, checkoutRunId: issues.checkoutRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]!);

    return { companyId, agentId, otherAgentId, issueId, runId, issuesSvc, readIssue };
  }

  it("precondition: shouldAutoCheckoutIssueForWake gates on assignee + status + wakeReason", async () => {
    const { agentId } = await seedFixture();
    const base = {
      issueStatus: "todo" as string | null,
      issueAssigneeAgentId: agentId,
      isDependencyReady: true,
      agentId,
    };

    expect(
      shouldAutoCheckoutIssueForWake({ ...base, contextSnapshot: { wakeReason: "issue_assigned" } }),
    ).toBe(true);

    expect(
      shouldAutoCheckoutIssueForWake({
        ...base,
        issueAssigneeAgentId: randomUUID(),
        contextSnapshot: { wakeReason: "issue_assigned" },
      }),
    ).toBe(false);

    expect(
      shouldAutoCheckoutIssueForWake({ ...base, issueStatus: "done", contextSnapshot: { wakeReason: "issue_assigned" } }),
    ).toBe(false);

    expect(
      shouldAutoCheckoutIssueForWake({ ...base, contextSnapshot: { wakeReason: "issue_comment_mentioned" } }),
    ).toBe(false);
    expect(
      shouldAutoCheckoutIssueForWake({ ...base, contextSnapshot: { wakeReason: "execution_stage_started" } }),
    ).toBe(false);
    expect(shouldAutoCheckoutIssueForWake({ ...base, contextSnapshot: {} })).toBe(false);
  });

  it("cold wake (no prior [session-start]) flips todo->in_progress and mints checkoutRunId", async () => {
    const { companyId, agentId, issueId, runId, issuesSvc, readIssue } = await seedFixture();

    const decision = await resolveResumeAutoCheckoutSkip({
      db,
      companyId,
      issueId,
      agentId,
      autoPromoteTodoOnResume: false,
    });
    expect(decision).toEqual({ skip: false, priorSessionStartFound: false });

    await issuesSvc.checkout(issueId, agentId, ["todo", "backlog", "blocked"], runId);

    const after = await readIssue();
    expect(after.status).toBe("in_progress");
    expect(after.checkoutRunId).toBe(runId);
  });

  it("resume wake (prior [session-start] from same agent) preserves todo and mints no checkoutRunId", async () => {
    const { companyId, agentId, issueId, issuesSvc, readIssue } = await seedFixture({
      priorSessionStartBy: "same-agent",
    });

    const decision = await resolveResumeAutoCheckoutSkip({
      db,
      companyId,
      issueId,
      agentId,
      autoPromoteTodoOnResume: false,
    });
    expect(decision).toEqual({ skip: true, priorSessionStartFound: true });

    expect(issuesSvc).toBeDefined();
    const after = await readIssue();
    expect(after.status).toBe("todo");
    expect(after.checkoutRunId).toBeNull();
  });

  it("autoPromoteTodoOnResume=true (upstream default) never skips, even on resume", async () => {
    const { companyId, agentId, issueId } = await seedFixture({ priorSessionStartBy: "same-agent" });

    const decision = await resolveResumeAutoCheckoutSkip({
      db,
      companyId,
      issueId,
      agentId,
      autoPromoteTodoOnResume: true,
    });
    expect(decision).toEqual({ skip: false, priorSessionStartFound: false });
  });

  it("a [session-start] from a different agent does not trigger the resume skip", async () => {
    const { companyId, agentId, issueId } = await seedFixture({ priorSessionStartBy: "other-agent" });

    const decision = await resolveResumeAutoCheckoutSkip({
      db,
      companyId,
      issueId,
      agentId,
      autoPromoteTodoOnResume: false,
    });
    expect(decision).toEqual({ skip: false, priorSessionStartFound: false });
  });
});
