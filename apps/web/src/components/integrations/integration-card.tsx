"use client";

import type { Integration } from "@clockoff/validation/integrations";
import { BellRing, Check, ExternalLink, LoaderCircle, Plug, RefreshCw, Unplug } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { InlineAlert } from "@/components/inline-alert";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { hasErrorCode } from "@/lib/api-client";
import {
  ACTIVATION_MODE_COPY,
  integrationCardState,
  providerInitials,
  safeExternalUrl,
  websiteLabel,
} from "./integration-view-model";
import {
  useConnectIntegration,
  useDisconnectIntegration,
  useNotifyMe,
  useSyncIntegration,
} from "./use-integrations";

export interface IntegrationCardProps {
  integration: Integration;
  /** `integrations:write` — connect, sync and disconnect. "Notify me" is open to every manager. */
  canWrite: boolean;
}

/**
 * One provider. While the provider is COMING_SOON the only action is "Notify me"; Connect is never shown as
 * if it worked. For an available provider Connect calls the API and follows `authorizationUrl` when given.
 */
export function IntegrationCard({ integration, canWrite }: IntegrationCardProps) {
  const state = integrationCardState(integration);
  const notify = useNotifyMe();
  const connect = useConnectIntegration();
  const disconnect = useDisconnectIntegration();
  const sync = useSyncIntegration();
  const toastError = useApiErrorToast();
  const website = safeExternalUrl(integration.website);

  const onNotify = () => {
    notify.mutate(integration.provider, {
      onSuccess: () => toast.success(`We'll email you when ${integration.displayName} is ready`),
      onError: (error) => toastError(error, { title: "Couldn't save your request" }),
    });
  };

  const onConnect = () => {
    connect.mutate(
      { provider: integration.provider },
      {
        onSuccess: (result) => {
          const url = result.authorizationUrl ? safeExternalUrl(result.authorizationUrl) : null;
          if (url) {
            toast.info(`Continue at ${integration.displayName} to finish connecting`);
            window.location.assign(url);
            return;
          }
          toast.success(`${integration.displayName} connected`);
        },
        onError: (error) => {
          if (hasErrorCode(error, "COMING_SOON")) {
            toast.info("Coming soon", {
              description: `${integration.displayName} can't be connected yet. Ask to be notified instead.`,
            });
            return;
          }
          toastError(error, { title: `Couldn't connect ${integration.displayName}` });
        },
      },
    );
  };

  const onSync = () => {
    sync.mutate(integration.provider, {
      onSuccess: (result) => {
        const { created, updated, skipped, errors } = result.report;
        toast.success(`${integration.displayName} synced`, {
          description: `${created} created, ${updated} updated, ${skipped} skipped${errors.length > 0 ? `, ${errors.length} errors` : ""}.`,
        });
      },
      onError: (error) => {
        if (hasErrorCode(error, "COMING_SOON")) {
          toast.info("Coming soon", {
            description: `Syncing ${integration.displayName} isn't available yet.`,
          });
          return;
        }
        toastError(error, { title: `Couldn't sync ${integration.displayName}` });
      },
    });
  };

  return (
    <li
      className="bg-card flex flex-col gap-5 rounded-xl border p-5 shadow-xs"
      data-provider={integration.provider}
      data-state={state}
    >
      <div className="flex items-start gap-4">
        <span
          className="bg-primary/10 text-primary flex size-12 shrink-0 items-center justify-center rounded-lg text-base font-semibold tracking-wide"
          aria-hidden="true"
        >
          {providerInitials(integration.displayName)}
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-semibold">{integration.displayName}</h3>
            {state === "coming-soon" ? (
              <Badge variant="secondary">Coming soon</Badge>
            ) : (
              <StatusBadge kind="integrationStatus" value={integration.status} size="sm" />
            )}
          </div>
          {website ? (
            <a
              href={website}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
            >
              {websiteLabel(integration.website)}
              <ExternalLink className="size-3" aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : null}
        </div>
      </div>

      <p className="text-muted-foreground text-sm leading-relaxed">{integration.description}</p>

      <dl className="space-y-2">
        <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Activation
        </dt>
        {integration.supportedActivationModes.map((mode) => (
          <dd key={mode} className="flex gap-2 text-sm">
            <span className="bg-muted mt-0.5 h-fit shrink-0 rounded px-1.5 py-0.5 text-xs font-medium">
              {ACTIVATION_MODE_COPY[mode].label}
            </span>
            <span className="text-muted-foreground">{ACTIVATION_MODE_COPY[mode].summary}</span>
          </dd>
        ))}
      </dl>

      {state === "connected" || state === "error" ? (
        <div className="space-y-2 text-sm">
          {integration.externalAccountName ? (
            <p>
              <span className="text-muted-foreground">Account: </span>
              {integration.externalAccountName}
            </p>
          ) : null}
          <p>
            <span className="text-muted-foreground">Last sync: </span>
            {integration.lastSyncAt ? <RelativeTime value={integration.lastSyncAt} /> : "Never"}
          </p>
          {state === "error" && integration.lastError ? (
            <InlineAlert variant="danger" title="Last sync failed">
              {integration.lastError}
            </InlineAlert>
          ) : null}
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        {state === "coming-soon" ? (
          integration.notifyRequested ? (
            <p
              className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400"
              role="status"
            >
              <Check className="size-4" aria-hidden="true" />
              We&apos;ll let you know when it&apos;s ready
            </p>
          ) : (
            <Button type="button" variant="outline" onClick={onNotify} disabled={notify.isPending}>
              {notify.isPending ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <BellRing aria-hidden="true" />
              )}
              Notify me
            </Button>
          )
        ) : state === "connected" || state === "error" ? (
          canWrite ? (
            <>
              <Button type="button" variant="outline" onClick={onSync} disabled={sync.isPending}>
                <RefreshCw
                  className={sync.isPending ? "animate-spin" : undefined}
                  aria-hidden="true"
                />
                Sync now
              </Button>
              <ConfirmDialog
                title={`Disconnect ${integration.displayName}?`}
                description="Shifts already imported stay as they are; nothing new will sync until you connect again."
                confirmLabel="Disconnect"
                destructive
                onConfirm={async () => {
                  try {
                    await disconnect.mutateAsync(integration.provider);
                    toast.success(`${integration.displayName} disconnected`);
                  } catch (error) {
                    toastError(error, { title: `Couldn't disconnect ${integration.displayName}` });
                    throw error;
                  }
                }}
                trigger={
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                  >
                    <Unplug aria-hidden="true" />
                    Disconnect
                  </Button>
                }
              />
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              Only owners and admins can sync or disconnect.
            </p>
          )
        ) : canWrite ? (
          <Button type="button" onClick={onConnect} disabled={connect.isPending}>
            {connect.isPending ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : (
              <Plug aria-hidden="true" />
            )}
            Connect
          </Button>
        ) : (
          <p className="text-muted-foreground text-sm">
            Only owners and admins can connect integrations.
          </p>
        )}
      </div>
    </li>
  );
}
