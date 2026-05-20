CREATE TABLE "operator_presence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"session_id" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operator_presence" ADD CONSTRAINT "operator_presence_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_presence" ADD CONSTRAINT "operator_presence_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_presence" ADD CONSTRAINT "operator_presence_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_presence_company_agent_session_uniq" ON "operator_presence" USING btree ("company_id","agent_id","session_id");--> statement-breakpoint
CREATE INDEX "operator_presence_company_issue_seen_idx" ON "operator_presence" USING btree ("company_id","issue_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "operator_presence_company_agent_seen_idx" ON "operator_presence" USING btree ("company_id","agent_id","last_seen_at");