import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";

/**
 * operator_presence — D1DX fork (D-1155).
 * Per-session liveness for operator-paced agents (adapterType "http", e.g. Codi).
 * Paperclip-spawned agents express liveness through heartbeat runs; operator-paced
 * agents have no runs, so a debounced PostToolUse hook on the operator's machine
 * upserts a row here while a Claude Code session is actively working an issue.
 * `lastSeenAt` is the freshness anchor — the read path treats a row as "live" only
 * within a short TTL. Rows are ephemeral and safe to prune.
 */
export const operatorPresence = pgTable(
  "operator_presence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentSessionUniqueIdx: uniqueIndex("operator_presence_company_agent_session_uniq").on(
      table.companyId,
      table.agentId,
      table.sessionId,
    ),
    companyIssueSeenIdx: index("operator_presence_company_issue_seen_idx").on(
      table.companyId,
      table.issueId,
      table.lastSeenAt,
    ),
    companyAgentSeenIdx: index("operator_presence_company_agent_seen_idx").on(
      table.companyId,
      table.agentId,
      table.lastSeenAt,
    ),
  }),
);
