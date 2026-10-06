import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type InlineAlertVariant = "info" | "success" | "warning" | "danger";

const VARIANTS: Record<InlineAlertVariant, { icon: LucideIcon; classes: string }> = {
  info: {
    icon: Info,
    classes: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100",
  },
  success: {
    icon: CircleCheck,
    classes:
      "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100",
  },
  warning: {
    icon: TriangleAlert,
    classes:
      "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100",
  },
  danger: {
    icon: CircleAlert,
    classes: "border-red-200 bg-red-50 text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100",
  },
};

export interface InlineAlertProps {
  variant?: InlineAlertVariant;
  title?: ReactNode;
  children?: ReactNode;
  /** Optional trailing action (button/link). */
  action?: ReactNode;
  icon?: LucideIcon;
  className?: string;
}

/**
 * Contextual message inside a page or form. `danger` alerts use `role="alert"` (announced immediately);
 * the others use `role="status"`.
 */
export function InlineAlert({ variant = "info", title, children, action, icon, className }: InlineAlertProps) {
  const { icon: DefaultIcon, classes } = VARIANTS[variant];
  const Icon = icon ?? DefaultIcon;
  return (
    <div
      role={variant === "danger" ? "alert" : "status"}
      className={cn("flex gap-3 rounded-lg border px-4 py-3 text-sm", classes, className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className="leading-5 font-medium">{title}</p> : null}
        {children ? <div className="leading-5 opacity-90">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  );
}
