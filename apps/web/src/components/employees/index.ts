/**
 * Public surface of the employees domain for other dashboard pages (schedule, overview, policies):
 * the employee combobox, status badges, invite instructions and the override dialog.
 */
export {
  EmployeePicker,
  type EmployeePickerProps,
  type EmployeePickerValue,
} from "./employee-picker";
export {
  DeviceStatusBadge,
  EmployeeStatusBadges,
  type DeviceStatusBadgeProps,
  type EmployeeStatusBadgesProps,
} from "./employee-status-badges";
export {
  InviteInstructionsModal,
  type InviteInstructionsModalProps,
} from "@/components/invites/invite-instructions-modal";
export {
  CreateInviteDialog,
  type CreateInviteDialogProps,
} from "@/components/invites/create-invite-dialog";
export {
  CreateOverrideDialog,
  type CreateOverrideDialogProps,
} from "@/components/overrides/create-override-dialog";
export { EmployeeFormSheet, type EmployeeFormSheetProps } from "./employee-form-sheet";
export {
  EmployeeActionDialogs,
  type EmployeeActionDialogsProps,
  type EmployeeActionRequest,
  type EmployeeDialogAction,
} from "./employee-action-dialogs";
export { employeeFullName, describeNextShift, describeResolvedFrom } from "./employee-view-model";
export { employeeKeys, overrideKeys, inviteKeys, referenceKeys } from "./employee-keys";
export {
  EMPLOYEE_QUICK_FILTERS,
  QUICK_FILTER_META,
  serializeEmployeeListParams,
  DEFAULT_EMPLOYEE_LIST_PARAMS,
  type EmployeeQuickFilter,
} from "./employee-filters";
export {
  useEmployee,
  useEmployees,
  useEmployeeSearch,
  useEmployeeState,
  invalidateEmployees,
} from "./employee-api";
