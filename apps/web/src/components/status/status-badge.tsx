import {
  Archive,
  Ban,
  Circle,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleQuestionMark,
  CircleX,
  Clock,
  Coffee,
  Crown,
  Hourglass,
  KeyRound,
  Mail,
  Pencil,
  Plug,
  Power,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Smartphone,
  TriangleAlert,
  Unplug,
  User,
  UserCheck,
  UserX,
  WifiOff,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getStatusMeta,
  TONE_CLASSES,
  type StatusIcon,
  type StatusKind,
  type StatusValue,
} from "./statusMeta";

/** Lucide component for each icon key in `statusMeta.ts` (exhaustive by type). */
export const STATUS_ICON_COMPONENTS: Record<StatusIcon, LucideIcon> = {
  circle: Circle,
  "circle-check": CircleCheck,
  "circle-dashed": CircleDashed,
  "circle-x": CircleX,
  "circle-pause": CirclePause,
  clock: Clock,
  coffee: Coffee,
  "shield-check": ShieldCheck,
  "shield-alert": ShieldAlert,
  "shield-off": ShieldOff,
  "triangle-alert": TriangleAlert,
  "wifi-off": WifiOff,
  refresh: RefreshCw,
  mail: Mail,
  send: Send,
  "user-check": UserCheck,
  "user-x": UserX,
  user: User,
  smartphone: Smartphone,
  archive: Archive,
  pencil: Pencil,
  crown: Crown,
  key: KeyRound,
  plug: Plug,
  unplug: Unplug,
  hourglass: Hourglass,
  ban: Ban,
  help: CircleQuestionMark,
  zap: Zap,
  power: Power,
};

export interface StatusBadgeProps<K extends StatusKind> {
  /** Which enum `value` belongs to. */
  kind: K;
  /** Enum value. Values unknown to this UI version (newer API) render as a neutral badge with a humanised label. */
  value: StatusValue<K>;
  /** Hide the icon (e.g. in dense tables). Default false. */
  hideIcon?: boolean;
  /** Override the label (e.g. "Owner (you)"). */
  label?: string;
  /**
   * Expose the status description to assistive tech and as a native tooltip. Default true — descriptions
   * explain what each status means for the employee's phone.
   */
  describe?: boolean;
  size?: "sm" | "md";
  className?: string;
}

/**
 * One component for every status enum: InviteStatus, DeviceStatusBadge, WorkModeState, PolicyStatus,
 * ShiftStatus, BreakSessionStatus, EmployeeInviteStatus, IntegrationStatus, Role and BillingStatus.
 * Colour is never the only signal: every badge has an icon and a text label.
 */
export function StatusBadge<K extends StatusKind>({
  kind,
  value,
  hideIcon = false,
  label,
  describe = true,
  size = "md",
  className,
}: StatusBadgeProps<K>) {
  const meta = getStatusMeta(kind, value);
  const Icon = STATUS_ICON_COMPONENTS[meta.icon];
  return (
    <span
      data-slot="status-badge"
      data-kind={kind}
      data-value={value}
      data-tone={meta.tone}
      title={describe && meta.description ? meta.description : undefined}
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border font-medium whitespace-nowrap",
        size === "md" ? "h-6 px-2.5 text-xs" : "h-5 px-2 text-[11px]",
        TONE_CLASSES[meta.tone],
        className,
      )}
    >
      {hideIcon ? null : (
        <Icon className={size === "md" ? "size-3.5" : "size-3"} aria-hidden="true" />
      )}
      <span>{label ?? meta.label}</span>
      {describe && meta.description ? <span className="sr-only">: {meta.description}</span> : null}
    </span>
  );
}
