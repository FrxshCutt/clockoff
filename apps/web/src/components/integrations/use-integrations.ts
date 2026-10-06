"use client";

import type { ActivationMode, IntegrationProvider } from "@workmode/shared/enums";
import {
  connectIntegrationResponseSchema,
  integrationResponseSchema,
  listIntegrationsResponseSchema,
  syncIntegrationResponseSchema,
  type ConnectIntegrationInput,
  type ConnectIntegrationResponse,
  type Integration,
  type ListIntegrationsResponse,
  type SyncIntegrationResponse,
} from "@workmode/validation/integrations";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { parseResponse } from "@/hooks/api-shapes";
import { api } from "@/lib/api-client";
import { providerPathSegment } from "./integration-view-model";

/** Queries and mutations for `/api/integrations` and `/api/integrations/:provider/{connect,disconnect,sync,notify-me}`. */

export const integrationKeys = {
  all: ["org", "integrations"] as const,
  list: ["org", "integrations", "list"] as const,
} as const;

function actionPath(
  provider: IntegrationProvider,
  action: "connect" | "disconnect" | "sync" | "notify-me",
): string {
  return `/api/integrations/${providerPathSegment(provider)}/${action}`;
}

export function useIntegrations(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: integrationKeys.list,
    queryFn: async ({ signal }): Promise<ListIntegrationsResponse> =>
      parseResponse(
        listIntegrationsResponseSchema,
        await api.get<unknown>("/api/integrations", undefined, signal),
        "GET /api/integrations",
      ),
    select: (data) => data.integrations,
    enabled: options.enabled ?? true,
  });
}

/** Writes one provider's fresh row into the cached list, then refetches so counts elsewhere catch up. */
async function settleIntegration(
  queryClient: QueryClient,
  integration: Integration,
): Promise<void> {
  queryClient.setQueryData<ListIntegrationsResponse>(integrationKeys.list, (current) =>
    current
      ? {
          integrations: current.integrations.map((item) =>
            item.provider === integration.provider ? integration : item,
          ),
        }
      : current,
  );
  await queryClient.invalidateQueries({ queryKey: integrationKeys.all });
}

/** `POST /api/integrations/:provider/notify-me` — records that the manager wants to hear when the provider ships. */
export function useNotifyMe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (provider: IntegrationProvider): Promise<Integration> =>
      parseResponse(
        integrationResponseSchema,
        await api.post<unknown>(actionPath(provider, "notify-me"), {}),
        "POST /api/integrations/:provider/notify-me",
      ).integration,
    onSuccess: (integration) => settleIntegration(queryClient, integration),
  });
}

/**
 * `POST /api/integrations/:provider/connect`. Answers 501 COMING_SOON until the provider is available; for an
 * OAuth provider the response carries `authorizationUrl` to send the manager to.
 */
export function useConnectIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      provider,
      activationMode,
    }: {
      provider: IntegrationProvider;
      activationMode?: ActivationMode;
    }): Promise<ConnectIntegrationResponse> => {
      const body: ConnectIntegrationInput = activationMode ? { activationMode } : {};
      return parseResponse(
        connectIntegrationResponseSchema,
        await api.post<unknown>(actionPath(provider, "connect"), body),
        "POST /api/integrations/:provider/connect",
      );
    },
    onSuccess: (result) => settleIntegration(queryClient, result.integration),
  });
}

export function useDisconnectIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (provider: IntegrationProvider): Promise<Integration> =>
      parseResponse(
        integrationResponseSchema,
        await api.post<unknown>(actionPath(provider, "disconnect"), {}),
        "POST /api/integrations/:provider/disconnect",
      ).integration,
    onSuccess: (integration) => settleIntegration(queryClient, integration),
  });
}

export function useSyncIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (provider: IntegrationProvider): Promise<SyncIntegrationResponse> =>
      parseResponse(
        syncIntegrationResponseSchema,
        await api.post<unknown>(actionPath(provider, "sync"), {}),
        "POST /api/integrations/:provider/sync",
      ),
    onSuccess: async (result) => {
      await settleIntegration(queryClient, result.integration);
      // A sync writes employees, locations, teams and shifts.
      await Promise.all(
        [
          ["org", "employees"],
          ["org", "locations"],
          ["org", "teams"],
          ["org", "shifts"],
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
  });
}
