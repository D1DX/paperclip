import { api } from "./client";

export interface LivePresenceResponse {
  issueIds: string[];
}

/**
 * Presence API — D1DX fork (D-1155).
 * Parallel liveness feed for operator-paced agents, which have no heartbeat
 * runs. The UI unions these issue ids into `collectLiveIssueIds` so the
 * existing blue "Live" issue pill is truthful for those agents too.
 */
export const presenceApi = {
  liveForCompany: (companyId: string) =>
    api.get<LivePresenceResponse>(`/companies/${companyId}/live-presence`),
};
