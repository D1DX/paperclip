import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { presenceApi } from "../api/presence";
import { queryKeys } from "../lib/queryKeys";

/**
 * Operator-presence liveness feed (D-1155). Returns the set of issue ids a
 * Claude Code session is actively working. Union this into
 * `collectLiveIssueIds(liveRuns)` at each issue-pill site so the blue "Live"
 * pill fires for operator-paced agents, which have no heartbeat runs.
 *
 * The 5s refetch matches the live-runs queries, so both liveness sources
 * refresh on the same cadence. The returned Set is referentially stable
 * between refetches — safe as a `useMemo` dependency.
 */
export function useLivePresenceIssueIds(companyId: string | null | undefined): Set<string> {
  const { data } = useQuery({
    queryKey: queryKeys.livePresence(companyId ?? "__no-company__"),
    queryFn: () => presenceApi.liveForCompany(companyId!),
    enabled: Boolean(companyId),
    refetchInterval: 5000,
  });
  return useMemo(() => new Set(data?.issueIds ?? []), [data]);
}
