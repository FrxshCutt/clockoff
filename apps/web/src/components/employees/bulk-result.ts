import type {
  BulkEmployeeActionResponse,
  EmployeeBulkAction,
} from "@workmode/validation/employees";
import { API_ERROR_MESSAGES } from "@/lib/errorMessages";

/** Copy for `POST /api/employees/bulk` results, shown as one toast per batch. */

export const BULK_ACTION_LABELS: Record<EmployeeBulkAction, { verb: string; past: string }> = {
  INVITE: { verb: "Send invites", past: "Invites sent" },
  ASSIGN_POLICY: { verb: "Assign policy", past: "Policy assigned" },
  ASSIGN_BREAK_POLICY: { verb: "Assign Break Rules", past: "Break Rules assigned" },
  ASSIGN_LOCATION: { verb: "Assign location", past: "Location assigned" },
  ADD_TO_TEAM: { verb: "Add to team", past: "Added to team" },
  DEACTIVATE: { verb: "Deactivate", past: "Deactivated" },
  REACTIVATE: { verb: "Reactivate", past: "Reactivated" },
  ARCHIVE: { verb: "Archive", past: "Archived" },
};

export interface BulkResultSummary {
  readonly tone: "success" | "warning" | "error";
  readonly title: string;
  readonly description: string | null;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Human copy for one failure; a code can mean something specific for a given action. */
function failureMessage(
  action: EmployeeBulkAction,
  code: BulkEmployeeActionResponse["failed"][number]["code"],
): string {
  // Reactivation only conflicts on the plan's active-employee limit (`details.reason = PLAN_LIMIT`).
  if (action === "REACTIVATE" && code === "CONFLICT") {
    return "Your plan's active-employee limit is reached. Upgrade or deactivate someone first.";
  }
  return API_ERROR_MESSAGES[code] ?? "Couldn't apply this change.";
}

/**
 * Summarises a bulk response: success when every item applied, warning when some failed, error when none
 * did. Failure lines use the human copy for the error code (never the raw server message) and the
 * employee's name when the caller can supply it.
 */
export function summariseBulkResult(
  result: BulkEmployeeActionResponse,
  nameFor: (employeeId: string) => string | null = () => null,
): BulkResultSummary {
  const label = BULK_ACTION_LABELS[result.action] ?? { verb: result.action, past: result.action };
  if (result.failed.length === 0) {
    return {
      tone: "success",
      title: `${label.past} for ${plural(result.succeeded, "employee")}`,
      description: null,
    };
  }
  const lines = result.failed.slice(0, 3).map((f) => {
    const name = nameFor(f.employeeId);
    const message = failureMessage(result.action, f.code);
    return name ? `${name}: ${message}` : message;
  });
  const more = result.failed.length > 3 ? ` …and ${result.failed.length - 3} more.` : "";
  const description = `${lines.join(" ")}${more}`;
  if (result.succeeded === 0) {
    return {
      tone: "error",
      title: `${label.verb} failed for ${plural(result.failed.length, "employee")}`,
      description,
    };
  }
  return {
    tone: "warning",
    title: `${label.past} for ${result.succeeded} of ${plural(result.processed, "employee")}`,
    description,
  };
}
