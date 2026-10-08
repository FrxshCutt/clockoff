"use client";

import {
  NOTIFICATION_PREFERENCE_DEFAULTS,
  type ManagerNotificationType,
  type NotificationPreferences,
} from "@clockoff/validation/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ErrorState } from "@/components/error-state";
import { InlineAlert } from "@/components/inline-alert";
import { CardSkeleton } from "@/components/loading-skeletons";
import { SectionCard } from "@/components/section";
import { Switch } from "@/components/ui/switch";
import { NOTIFICATION_TYPE_COPY, visibleNotificationTypes } from "@/config/settings";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { usePlandayEnabled } from "@/hooks/use-current-user";
import {
  useNotificationPreferences,
  useUpdateNotificationPreferences,
  type Availability,
} from "@/hooks/use-settings";
import { queryKeys } from "@/lib/query-client";

type Channel = "inApp" | "email";
const CHANNELS: readonly { key: Channel; label: string }[] = [
  { key: "inApp", label: "In dashboard" },
  { key: "email", label: "Email" },
];

/**
 * Settings → Notifications: the caller's own alert preferences (`GET` / `PATCH /api/settings`). Each switch
 * saves immediately and flips optimistically (a preference toggle is safe to show before the server
 * confirms); a failed save puts the previous value back. Until the endpoint ships, the defaults are shown
 * read-only with an explanation. The integration sync rows appear only while Planday is switched on.
 */
export function NotificationSettings() {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch, isRefetching } = useNotificationPreferences();
  const update = useUpdateNotificationPreferences();
  const toastError = useApiErrorToast();
  const types = visibleNotificationTypes(usePlandayEnabled());

  if (isPending) return <CardSkeleton lines={6} />;
  if (isError) {
    return (
      <ErrorState
        title="Couldn't load notification preferences"
        error={error}
        onRetry={() => void refetch()}
        isRetrying={isRefetching}
      />
    );
  }

  const available = data.available;
  const preferences: NotificationPreferences = data.data ?? NOTIFICATION_PREFERENCE_DEFAULTS;

  const toggle = (type: ManagerNotificationType, channel: Channel, value: boolean) => {
    const key = queryKeys.notificationPreferences;
    const previous = queryClient.getQueryData<Availability<NotificationPreferences>>(key);
    if (previous?.available) {
      queryClient.setQueryData<Availability<NotificationPreferences>>(key, {
        available: true,
        data: { ...previous.data, [type]: { ...previous.data[type], [channel]: value } },
      });
    }
    update.mutate(
      { [type]: { [channel]: value } },
      {
        onSuccess: () => toast.success("Notification preferences saved"),
        onError: (err) => {
          if (previous) queryClient.setQueryData(key, previous);
          toastError(err, { title: "Couldn't save your preference" });
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      {available ? null : (
        <InlineAlert variant="info" title="Notification preferences aren't available yet">
          You&apos;ll receive the defaults shown below. You&apos;ll be able to change them here
          soon.
        </InlineAlert>
      )}
      <SectionCard
        title="Alerts"
        description="These preferences are personal: they only change what you receive."
        flush
        contentClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Notification preferences by alert type and channel
            </caption>
            <thead className="bg-muted/40 border-b">
              <tr>
                <th
                  scope="col"
                  className="text-muted-foreground px-5 py-3 text-left text-xs font-medium tracking-wide uppercase sm:px-6"
                >
                  Alert
                </th>
                {CHANNELS.map((channel) => (
                  <th
                    key={channel.key}
                    scope="col"
                    className="text-muted-foreground w-28 px-3 py-3 text-center text-xs font-medium tracking-wide uppercase"
                  >
                    {channel.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {types.map((type) => (
                <PreferenceRow
                  key={type}
                  type={type}
                  value={preferences[type]}
                  disabled={!available || update.isPending}
                  onToggle={toggle}
                />
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}

function PreferenceRow({
  type,
  value,
  disabled,
  onToggle,
}: {
  type: ManagerNotificationType;
  value: NotificationPreferences[ManagerNotificationType];
  disabled: boolean;
  onToggle: (type: ManagerNotificationType, channel: Channel, value: boolean) => void;
}) {
  const copy = NOTIFICATION_TYPE_COPY[type];
  return (
    <tr>
      <th scope="row" className="px-5 py-4 text-left font-normal sm:px-6">
        <p className="font-medium">{copy.label}</p>
        <p className="text-muted-foreground mt-0.5 text-xs">{copy.description}</p>
      </th>
      {CHANNELS.map((channel) => (
        <td key={channel.key} className="px-3 py-4 text-center">
          <Switch
            checked={value[channel.key]}
            disabled={disabled}
            onCheckedChange={(checked) => onToggle(type, channel.key, checked)}
            aria-label={`${copy.label}: ${channel.label}`}
          />
        </td>
      ))}
    </tr>
  );
}
