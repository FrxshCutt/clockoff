"use client";

import type { Employee } from "@clockoff/validation/employees";
import { FlaskConical, KeyRound, Pencil, Send, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { canInviteEmployee, inviteActionLabel } from "@/components/invites/invite-helpers";
import { CreateOverrideDialog } from "@/components/overrides/create-override-dialog";
import { PageHeader } from "@/components/page-header";
import { BackLink } from "@/components/placeholder-page";
import { useBreadcrumbLabel } from "@/components/shell/breadcrumb-store";
import { CreateTestShiftDialog } from "@/components/test-tools/create-test-shift-dialog";
import { TEST_SHIFT_COPY } from "@/components/test-tools/test-shift-model";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EMPTY_STATES } from "@/config/emptyStates";
import { ROUTES } from "@/config/navigation";
import { useCanCreateTestShift, usePermission } from "@/hooks/use-current-user";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import { hasErrorCode } from "@/lib/api-client";
import {
  EmployeeActionDialogs,
  type EmployeeActionRequest,
  type EmployeeDialogAction,
} from "./employee-action-dialogs";
import { EmployeeActivityTab } from "./employee-activity-tab";
import { useEmployee } from "./employee-api";
import { EmployeeDetailSkeleton } from "./employee-detail-skeleton";
import {
  EMPLOYEE_TABS,
  EMPLOYEE_TAB_META,
  parseEmployeeTab,
  type EmployeeTab,
} from "./employee-copy";
import { EmployeeInvitesTab } from "./employee-invites-tab";
import { EmployeeOverridesTab } from "./employee-overrides-tab";
import { EmployeeOverviewTab } from "./employee-overview-tab";
import { EmployeePolicyTab } from "./employee-policy-tab";
import { EmployeeRowActionsMenu } from "./employee-row-actions";
import { EmployeeScheduleTab } from "./employee-schedule-tab";
import { EmployeeStatusBadges } from "./employee-status-badges";
import { employeeFullName } from "./employee-view-model";

export interface EmployeeDetailPageProps {
  id: string;
  /** `?tab=` from the request; the page owns the tab state afterwards and mirrors it to the URL. */
  initialTab?: string | undefined;
}

/** /employees/[id] — header with status and actions, then Overview / Schedule / Policy / Activity / Invites / Overrides. */
export function EmployeeDetailPage({ id, initialTab }: EmployeeDetailPageProps) {
  const router = useRouter();
  const query = useEmployee(id);
  const canWrite = usePermission("employees:write");
  const canOverride = usePermission("overrides:create");
  const canCreateTestShift = useCanCreateTestShift();
  const organisation = useCurrentOrganisation();
  const [tab, setTab] = useState<EmployeeTab>(() => parseEmployeeTab(initialTab));
  const [request, setRequest] = useState<EmployeeActionRequest | null>(null);

  const employee = query.data;
  const name = employee ? employeeFullName(employee) : null;
  useBreadcrumbLabel(id, name);

  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const url = new URL(window.location.href);
    if (tab === "overview") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [tab]);

  if (!employee) {
    if (query.isError) {
      if (hasErrorCode(query.error, "EMPLOYEE_NOT_FOUND", "NOT_FOUND")) {
        return (
          <>
            <PageHeader
              title="Employee not found"
              eyebrow={<BackLink href={ROUTES.employees}>Employees</BackLink>}
            />
            <EmptyState
              icon={Users}
              title="This employee doesn't exist"
              description="They may have been archived, or the link is for another organisation."
              action={
                <Button asChild>
                  <Link href={ROUTES.employees}>{EMPTY_STATES.employeeDetail.action.label}</Link>
                </Button>
              }
            />
          </>
        );
      }
      return (
        <>
          <PageHeader
            title="Employee"
            eyebrow={<BackLink href={ROUTES.employees}>Employees</BackLink>}
          />
          <ErrorState
            title="Couldn't load this employee"
            error={query.error}
            onRetry={() => void query.refetch()}
            isRetrying={query.isRefetching}
          />
        </>
      );
    }
    return <EmployeeDetailSkeleton />;
  }

  const onAction = (action: EmployeeDialogAction, target: Employee) =>
    setRequest({ action, employee: target });
  const inviteLabel = inviteActionLabel(employee.inviteStatus);
  const meta = [employee.jobTitle, employee.department?.name, employee.primaryLocation?.name]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <PageHeader
        eyebrow={<BackLink href={ROUTES.employees}>Employees</BackLink>}
        title={name}
        description={meta || "No job title, department or location yet."}
        actions={
          <>
            {canWrite && inviteLabel && canInviteEmployee(employee) ? (
              <Button type="button" onClick={() => onAction("invite", employee)}>
                <Send aria-hidden="true" />
                {inviteLabel}
              </Button>
            ) : null}
            {canOverride && employee.employmentStatus === "ACTIVE" ? (
              <CreateOverrideDialog
                employee={employee}
                trigger={
                  <Button type="button" variant="outline">
                    <KeyRound aria-hidden="true" />
                    Override
                  </Button>
                }
              />
            ) : null}
            {canCreateTestShift && employee.employmentStatus === "ACTIVE" ? (
              <CreateTestShiftDialog
                employee={employee}
                trigger={
                  <Button type="button" variant="outline">
                    <FlaskConical aria-hidden="true" />
                    {TEST_SHIFT_COPY.action}
                  </Button>
                }
              />
            ) : null}
            {canWrite ? (
              <Button type="button" variant="outline" onClick={() => onAction("edit", employee)}>
                <Pencil aria-hidden="true" />
                Edit
              </Button>
            ) : null}
            <EmployeeRowActionsMenu
              employee={employee}
              canWrite={canWrite}
              onAction={onAction}
              showView={false}
              size="icon"
              variant="outline"
              label={`More actions for ${name}`}
            />
          </>
        }
      />

      <div className="-mt-2 mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <EmployeeStatusBadges
          employee={employee}
          timeZone={organisation.data?.organisation.timezone}
        />
        <dl className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {employee.email ? (
            <div className="flex gap-1">
              <dt className="sr-only">Email</dt>
              <dd>{employee.email}</dd>
            </div>
          ) : null}
          {employee.phone ? (
            <div className="flex gap-1">
              <dt className="sr-only">Phone</dt>
              <dd>{employee.phone}</dd>
            </div>
          ) : null}
          {employee.externalEmployeeId ? (
            <div className="flex gap-1">
              <dt>ID</dt>
              <dd className="font-mono">{employee.externalEmployeeId}</dd>
            </div>
          ) : null}
          {employee.teams.length > 0 ? (
            <div className="flex gap-1">
              <dt>{employee.teams.length === 1 ? "Team" : "Teams"}</dt>
              <dd>{employee.teams.map((t) => t.name).join(", ")}</dd>
            </div>
          ) : null}
        </dl>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(parseEmployeeTab(value))}
        className="gap-6"
      >
        <div className="overflow-x-auto border-b">
          <TabsList variant="line" aria-label="Employee sections" className="h-10">
            {EMPLOYEE_TABS.map((key) => (
              <TabsTrigger
                key={key}
                value={key}
                title={EMPLOYEE_TAB_META[key].description}
                className="px-3"
              >
                {EMPLOYEE_TAB_META[key].label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="overview">
          <EmployeeOverviewTab employee={employee} />
        </TabsContent>
        <TabsContent value="schedule">
          <EmployeeScheduleTab employee={employee} />
        </TabsContent>
        <TabsContent value="policy">
          <EmployeePolicyTab employee={employee} />
        </TabsContent>
        <TabsContent value="activity">
          <EmployeeActivityTab employeeId={employee.id} />
        </TabsContent>
        <TabsContent value="invites">
          <EmployeeInvitesTab employee={employee} />
        </TabsContent>
        <TabsContent value="overrides">
          <EmployeeOverridesTab employee={employee} />
        </TabsContent>
      </Tabs>

      <EmployeeActionDialogs
        request={request}
        onClose={() => setRequest(null)}
        onCompleted={(completed) => {
          if (completed.action === "archive") router.push(ROUTES.employees);
        }}
      />
    </>
  );
}
