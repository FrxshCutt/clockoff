"use client";

import type { EmployeeDetail } from "@workmode/validation/employees";
import { KeyRound } from "lucide-react";
import { InlineAlert } from "@/components/inline-alert";
import { CreateOverrideDialog } from "@/components/overrides/create-override-dialog";
import { OverridesTable } from "@/components/overrides/overrides-table";
import { SectionCard } from "@/components/section";
import { Button } from "@/components/ui/button";
import { usePermission } from "@/hooks/use-current-user";

export interface EmployeeOverridesTabProps {
  employee: EmployeeDetail;
}

/** Manager overrides for this employee (`GET /api/overrides?employeeId=`) with create and revoke. */
export function EmployeeOverridesTab({ employee }: EmployeeOverridesTabProps) {
  const canCreate = usePermission("overrides:create");
  const active = employee.employmentStatus === "ACTIVE";

  const createAction =
    canCreate && active ? (
      <CreateOverrideDialog
        employee={employee}
        trigger={
          <Button type="button" size="sm">
            <KeyRound aria-hidden="true" />
            Create override
          </Button>
        }
      />
    ) : null;

  return (
    <SectionCard
      title="Overrides"
      description="Temporary changes to what the phone restricts: exempt the employee, end Work Mode early, relax categories for a while, or an emergency lift. Every override records who did it and why."
      actions={createAction}
      flush
    >
      <div className="space-y-4 px-5 py-5 sm:px-6">
        {!active ? (
          <InlineAlert variant="info">
            Overrides can only be created for active employees.
          </InlineAlert>
        ) : null}
        <OverridesTable
          employeeId={employee.id}
          canRevoke={canCreate}
          createAction={createAction ?? undefined}
        />
      </div>
    </SectionCard>
  );
}
