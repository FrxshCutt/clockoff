"use client";

import { joinCodeResponseSchema, type JoinCodeResponse } from "@clockoff/validation/organisation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "@/hooks/api-shapes";
import { api, hasErrorCode } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";

/**
 * `GET /api/organisations/current/join-code` (active code + history) and the regenerate / revoke actions.
 * The endpoint may not be deployed yet; a 404 / 501 resolves to `{ available: false }` so the Join code tab can
 * fall back to the active code embedded in `GET /api/organisations/current`.
 */

export type JoinCodeState =
  { available: true; data: JoinCodeResponse } | { available: false; data: null };

const JOIN_CODE_PATH = "/api/organisations/current/join-code";

export function useJoinCode(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.joinCode,
    enabled: options.enabled ?? true,
    queryFn: async ({ signal }): Promise<JoinCodeState> => {
      try {
        const raw = await api.get<unknown>(JOIN_CODE_PATH, undefined, signal);
        return {
          available: true,
          data: parseResponse(joinCodeResponseSchema, raw, `GET ${JOIN_CODE_PATH}`),
        };
      } catch (error) {
        if (hasErrorCode(error, "NOT_FOUND", "COMING_SOON"))
          return { available: false, data: null };
        throw error;
      }
    },
  });
}

function useJoinCodeAction(action: "regenerate" | "revoke") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<JoinCodeResponse | null> => {
      const raw = await api.post<unknown>(`${JOIN_CODE_PATH}/${action}`);
      const parsed = joinCodeResponseSchema.safeParse(raw);
      // The response shape is informative only; the queries below are the source of truth.
      return parsed.success ? parsed.data : null;
    },
    onSuccess: async (data) => {
      if (data)
        queryClient.setQueryData<JoinCodeState>(queryKeys.joinCode, { available: true, data });
      // The organisation response embeds the active code (top bar chip, overview card); its key is a prefix
      // of the join-code key, so this refreshes both.
      await queryClient.invalidateQueries({ queryKey: queryKeys.currentOrganisation });
    },
  });
}

/** `POST /api/organisations/current/join-code/regenerate` — revokes the active code and issues a new one. */
export function useRegenerateCompanyCode() {
  return useJoinCodeAction("regenerate");
}

/** `POST /api/organisations/current/join-code/revoke` — revokes the active code without replacing it. */
export function useRevokeCompanyCode() {
  return useJoinCodeAction("revoke");
}
