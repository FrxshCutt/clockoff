"use client";

import { PRIVACY_PRINCIPLE } from "@workmode/shared/privacyStatements";
import { Power, Smartphone } from "lucide-react";
import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  PERMISSION_STATE_GUIDANCE,
  SELECTION_STATE_GUIDANCE,
} from "@/components/employees/employee-view-model";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { InlineAlert } from "@/components/inline-alert";
import { CardSkeleton } from "@/components/loading-skeletons";
import { PageHeader } from "@/components/page-header";
import { BackLink } from "@/components/placeholder-page";
import { RelativeTime } from "@/components/relative-time";
import { SectionCard } from "@/components/section";
import { useBreadcrumbLabel } from "@/components/shell/breadcrumb-store";
import { StatusBadge } from "@/components/status/status-badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ROUTES, routeFor } from "@/config/navigation";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { usePermission } from "@/hooks/use-current-user";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import { hasErrorCode } from "@/lib/api-client";
import { formatDateTime, formatTimeZoneLabel } from "@/lib/format";
import { useDeactivateDevice, useDevice } from "./device-api";
import {
  describeAppVersion,
  describeClockSkew,
  describeOs,
  describePolicyVersion,
  describeSelectionCounts,
  deviceDisplayName,
} from "./device-model";
import { TonedBadge } from "./toned-badge";

interface Fact {
  readonly label: string;
  readonly value: ReactNode;
  /** Secondary line under the value. */
  readonly hint?: ReactNode;
}

function Facts({ items }: { items: readonly Fact[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className="min-w-0 space-y-1">
          <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {item.label}
          </dt>
          <dd className="text-sm">{item.value}</dd>
          {item.hint ? (
            <dd className="text-muted-foreground text-xs text-pretty">{item.hint}</dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}

/** Loading frame. The page keeps its title slot (one `<h1>` per page) with a skeleton where the device name will go. */
function DeviceDetailSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="space-y-6">
      <PageHeader
        eyebrow={<BackLink href={ROUTES.devices}>Devices</BackLink>}
        title={
          <>
            <span className="sr-only">Loading device…</span>
            <Skeleton className="h-8 w-64" aria-hidden="true" />
          </>
        }
      />
      <div className="grid gap-6 md:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <CardSkeleton key={i} lines={4} />
        ))}
      </div>
    </div>
  );
}

/**
 * `/devices/[id]`: everything a manager may see about one phone (§12) and the one action that exists for
 * it — deactivate, which revokes its tokens so it must join again.
 */
export function DeviceDetail({ id }: { id: string }) {
  const query = useDevice(id);
  const organisation = useCurrentOrganisation();
  const canWrite = usePermission("employees:write");
  const deactivate = useDeactivateDevice();
  const toastError = useApiErrorToast();
  const [reason, setReason] = useState("");
  const reasonId = useId();

  const data = query.data;
  const title = data ? deviceDisplayName(data.device, data.employee) : null;
  useBreadcrumbLabel(id, title);

  if (query.isPending) return <DeviceDetailSkeleton />;

  if (query.isError) {
    if (hasErrorCode(query.error, "NOT_FOUND")) {
      return (
        <>
          <PageHeader title="Device" eyebrow={<BackLink href={ROUTES.devices}>Devices</BackLink>} />
          <EmptyState
            icon={Smartphone}
            title="Device not found"
            description="This device may have been removed, or the link is out of date."
            action={
              <Button asChild variant="outline">
                <Link href={ROUTES.devices}>Back to devices</Link>
              </Button>
            }
          />
        </>
      );
    }
    return (
      <>
        <PageHeader title="Device" eyebrow={<BackLink href={ROUTES.devices}>Devices</BackLink>} />
        <ErrorState
          title="Couldn't load this device"
          error={query.error}
          onRetry={() => void query.refetch()}
          isRetrying={query.isRefetching}
        />
      </>
    );
  }

  // `query.data` (not the `data` alias above) so the pending/error checks narrow it to the loaded shape.
  const { device, employee, status } = query.data;
  const timeZone = organisation.data?.organisation.timezone;
  const dateFormat = organisation.data?.organisation.dateFormat;
  const employeeName = `${employee.firstName} ${employee.lastName}`.trim();
  const permission = PERMISSION_STATE_GUIDANCE[device.permissionState];
  const selection = SELECTION_STATE_GUIDANCE[device.selectionState];
  const clock = describeClockSkew(device.lastClockSkewSeconds);
  const when = (value: string | null) =>
    value ? formatDateTime(value, { timeZone, dateFormat }) : "—";

  const confirmDeactivate = async () => {
    try {
      await deactivate.mutateAsync({ id, reason });
      setReason("");
      toast.success(`${title ?? "Device"} deactivated. The phone must join again to reconnect.`);
    } catch (error) {
      toastError(error, { title: "Couldn't deactivate the device" });
      throw error; // keeps the dialog open so the manager can retry or cancel
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={<BackLink href={ROUTES.devices}>Devices</BackLink>}
        title={title ?? "Device"}
        description={
          <>
            <Link
              href={routeFor.employee(employee.id)}
              className="text-primary font-medium underline-offset-4 hover:underline"
            >
              {employeeName}
            </Link>
            {employee.jobTitle ? ` · ${employee.jobTitle}` : ""}
            {employee.primaryLocation ? ` · ${employee.primaryLocation.name}` : ""}
          </>
        }
        actions={
          <>
            {status ? <StatusBadge kind="deviceStatus" value={status.badge} /> : null}
            <StatusBadge kind="workModeState" value={device.restrictionEngineState} />
            {device.isActive ? (
              <TonedBadge tone="success" description="The phone syncs and enforces Work Mode.">
                Active
              </TonedBadge>
            ) : (
              <TonedBadge
                tone="neutral"
                description="Deactivated: the phone no longer syncs and must join again."
              >
                Deactivated
              </TonedBadge>
            )}
            {device.isActive && canWrite ? (
              <ConfirmDialog
                title={`Deactivate ${title ?? "this device"}?`}
                description="The phone signs out immediately and stops syncing. Work Mode will not run on it until the employee joins again from the app. The employee record is unaffected."
                confirmLabel="Deactivate device"
                destructive
                onConfirm={confirmDeactivate}
                trigger={
                  <Button type="button" variant="destructive">
                    <Power aria-hidden="true" />
                    Deactivate
                  </Button>
                }
              >
                <div className="space-y-2">
                  <Label htmlFor={reasonId}>
                    Reason{" "}
                    <span className="text-muted-foreground font-normal">
                      (optional, kept in the audit log)
                    </span>
                  </Label>
                  <Textarea
                    id={reasonId}
                    value={reason}
                    maxLength={500}
                    rows={3}
                    placeholder="e.g. Phone replaced"
                    onChange={(event) => setReason(event.target.value)}
                  />
                </div>
              </ConfirmDialog>
            ) : null}
          </>
        }
      />

      <div className="space-y-6">
        {!device.isActive ? (
          <InlineAlert variant="warning" title="This device is deactivated">
            Deactivated{" "}
            <RelativeTime value={device.deactivatedAt} fallback="earlier" timeZone={timeZone} />. It
            no longer syncs; the employee must join again from the Work Mode app to reconnect.
          </InlineAlert>
        ) : null}

        <div className="grid gap-6 md:grid-cols-2">
          <SectionCard title="Screen Time" description="Whether the phone can apply restrictions.">
            <Facts
              items={[
                {
                  label: "Authorisation",
                  value: (
                    <TonedBadge tone={permission.tone} description={permission.guidance}>
                      {permission.label}
                    </TonedBadge>
                  ),
                  hint: permission.guidance,
                },
                {
                  label: "App selection",
                  value: (
                    <TonedBadge tone={selection.tone} description={selection.guidance}>
                      {selection.label}
                    </TonedBadge>
                  ),
                  hint: `${describeSelectionCounts(device.selectionCounts)}. ${selection.guidance}`,
                },
                {
                  label: "Engine state",
                  value: (
                    <StatusBadge
                      kind="workModeState"
                      value={device.restrictionEngineState}
                      size="sm"
                    />
                  ),
                  hint: "The on-device Work Mode state as last reported.",
                },
              ]}
            />
          </SectionCard>

          <SectionCard title="Connection" description="How recently the phone checked in.">
            <Facts
              items={[
                {
                  label: "Status",
                  value: status ? (
                    <StatusBadge kind="deviceStatus" value={status.badge} size="sm" />
                  ) : (
                    "Not evaluated"
                  ),
                  hint:
                    status?.reason ??
                    (status
                      ? undefined
                      : "No live status for a deactivated device or an inactive employee."),
                },
                {
                  label: "Last seen",
                  value: (
                    <RelativeTime value={device.lastSeenAt} fallback="Never" timeZone={timeZone} />
                  ),
                  hint: when(device.lastSeenAt),
                },
                {
                  label: "Last device sync",
                  value: (
                    <RelativeTime
                      value={device.lastDeviceSyncAt}
                      fallback="Never"
                      timeZone={timeZone}
                    />
                  ),
                  hint: when(device.lastDeviceSyncAt),
                },
                {
                  label: "Device clock",
                  value: clock ?? "Not reported",
                  hint:
                    clock && clock !== "In sync"
                      ? "Ask the employee to enable automatic date and time."
                      : undefined,
                },
                {
                  label: "Push notifications",
                  value: device.hasPushToken ? "Registered" : "Not registered",
                  hint: "Only whether a token exists; the token itself is never shown.",
                },
                {
                  label: "Time zone",
                  value: device.timezone ? formatTimeZoneLabel(device.timezone) : "—",
                },
              ]}
            />
          </SectionCard>

          <SectionCard title="Policy & schedule" description="What the phone has downloaded.">
            <Facts
              items={[
                { label: "Work Policy", value: describePolicyVersion(device) },
                {
                  label: "Last policy sync",
                  value: (
                    <RelativeTime
                      value={device.lastPolicySyncAt}
                      fallback="Never"
                      timeZone={timeZone}
                    />
                  ),
                  hint: when(device.lastPolicySyncAt),
                },
                { label: "Schedule version", value: device.scheduleVersion },
                {
                  label: "Last schedule sync",
                  value: (
                    <RelativeTime
                      value={device.lastScheduleSyncAt}
                      fallback="Never"
                      timeZone={timeZone}
                    />
                  ),
                  hint: when(device.lastScheduleSyncAt),
                },
              ]}
            />
          </SectionCard>

          <SectionCard title="Device" description="App and operating system.">
            <Facts
              items={[
                {
                  label: "Platform",
                  value: device.platform === "IOS" ? "iPhone (iOS)" : device.platform,
                },
                { label: "Model", value: device.deviceModel ?? "—" },
                { label: "App version", value: describeAppVersion(device) },
                { label: "Operating system", value: describeOs(device) },
                { label: "Joined", value: when(device.createdAt) },
                ...(device.deactivatedAt
                  ? [{ label: "Deactivated", value: when(device.deactivatedAt) }]
                  : []),
              ]}
            />
          </SectionCard>
        </div>

        <InlineAlert variant="info" title={PRIVACY_PRINCIPLE}>
          This page shows operational signals only. Work Mode never receives which apps the employee
          selected, their messages, photos, browsing, notifications, location or anything else on
          the phone.
        </InlineAlert>
      </div>
    </>
  );
}
