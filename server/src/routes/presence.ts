import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden, unprocessable } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { listLivePresenceIssueIds, upsertOperatorPresence } from "../services/presence.js";

/**
 * Presence routes — D1DX fork (D-1155).
 * Operator-paced agents (adapterType "http", e.g. Codi) have no heartbeat runs,
 * so a debounced PostToolUse hook on the operator's machine POSTs here to keep a
 * per-session liveness row fresh. The agent is identified by its token; the body
 * carries only the session id and the currently pinned issue id.
 */
export function presenceRoutes(db: Db) {
  const router = Router();

  router.post("/presence", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      throw forbidden("Agent authentication required");
    }

    const sessionId =
      typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
    if (!sessionId) throw unprocessable("sessionId is required");

    const issueId =
      typeof req.body?.issueId === "string" && req.body.issueId.trim().length > 0
        ? req.body.issueId.trim()
        : null;

    await upsertOperatorPresence(db, {
      companyId: req.actor.companyId,
      agentId: req.actor.agentId,
      sessionId,
      issueId,
    });

    res.json({ ok: true });
  });

  /**
   * Parallel liveness feed for operator-paced agents. Returns the issue ids
   * with a fresh `operator_presence` row — the UI unions these into
   * `collectLiveIssueIds` so the existing blue "Live" issue pill fires for
   * agents that have no heartbeat runs. Kept separate from `/live-runs` so
   * synthetic rows never pollute the run-detail consumers.
   */
  router.get("/companies/:companyId/live-presence", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const issueIds = await listLivePresenceIssueIds(db, companyId);
    res.json({ issueIds });
  });

  return router;
}
