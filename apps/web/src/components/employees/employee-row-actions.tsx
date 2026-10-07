"use client";

import type { Employee } from "@clockoff/validation/employees";
import {
  Archive,
  Coffee,
  Eye,
  MoreHorizontal,
  Pencil,
  Power,
  PowerOff,
  Send,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { canInviteEmployee, inviteActionLabel } from "@/components/invites/invite-helpers";
import { routeFor } from "@/config/navigation";
import type { EmployeeDialogAction } from "./employee-action-dialogs";
import { employeeFullName } from "./employee-view-model";

export interface EmployeeRowActionsMenuProps {
  employee: Employee;
  canWrite: boolean;
  onAction: (action: EmployeeDialogAction, employee: Employee) => void;
  /** Hide "View" when already on the detail page. */
  showView?: boolean;
  /** Trigger button size. */
  size?: "icon-sm" | "icon";
  variant?: "ghost" | "outline";
  label?: string;
}

/** Row / header "…" menu: View, Edit, Invite/Resend, Assign policy / Break Rules, Deactivate/Reactivate, Archive. */
export function EmployeeRowActionsMenu({
  employee,
  canWrite,
  onAction,
  showView = true,
  size = "icon-sm",
  variant = "ghost",
  label,
}: EmployeeRowActionsMenuProps) {
  const name = employeeFullName(employee);
  const inviteLabel = inviteActionLabel(employee.inviteStatus);
  const active = employee.employmentStatus === "ACTIVE";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size={size}
          aria-label={label ?? `Actions for ${name}`}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {showView ? (
          <DropdownMenuItem asChild>
            <Link href={routeFor.employee(employee.id)}>
              <Eye aria-hidden="true" />
              View
            </Link>
          </DropdownMenuItem>
        ) : null}
        {canWrite ? (
          <>
            <DropdownMenuItem onSelect={() => onAction("edit", employee)}>
              <Pencil aria-hidden="true" />
              Edit
            </DropdownMenuItem>
            {inviteLabel && canInviteEmployee(employee) ? (
              <DropdownMenuItem onSelect={() => onAction("invite", employee)}>
                <Send aria-hidden="true" />
                {inviteLabel}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => onAction("assignPolicy", employee)}>
              <ShieldCheck aria-hidden="true" />
              Assign policy
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction("assignBreakPolicy", employee)}>
              <Coffee aria-hidden="true" />
              Assign Break Rules
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {active ? (
              <DropdownMenuItem onSelect={() => onAction("deactivate", employee)}>
                <PowerOff aria-hidden="true" />
                Deactivate
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => onAction("reactivate", employee)}>
                <Power aria-hidden="true" />
                Reactivate
              </DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onSelect={() => onAction("archive", employee)}>
              <Archive aria-hidden="true" />
              Archive
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
