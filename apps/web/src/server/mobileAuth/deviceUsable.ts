import type { Employee, Organisation } from "@workmode/db";
import { AppError } from "@workmode/shared/errors";

/**
 * A device credential (access token or refresh token) is only honoured while the device is active, its
 * employee is ACTIVE and not deleted, and its organisation still exists. Shared by the access-token
 * check (`getCurrentDeviceContext`) and refresh-token rotation, so a deactivated employee cannot keep
 * minting tokens.
 */
export function assertDeviceUsable(device: {
  isActive: boolean;
  employee: Pick<Employee, "deletedAt" | "employmentStatus">;
  organisation: Pick<Organisation, "deletedAt">;
}): void {
  if (!device.isActive) throw new AppError("DEVICE_INACTIVE", "This device has been deactivated");
  if (device.organisation.deletedAt || device.employee.deletedAt) {
    throw new AppError("UNAUTHENTICATED", "Account no longer available");
  }
  if (device.employee.employmentStatus !== "ACTIVE") {
    throw new AppError("DEVICE_INACTIVE", "This employee has been deactivated");
  }
}
