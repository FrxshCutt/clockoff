import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface MetricTrend {
  direction: "up" | "down" | "flat";
  /** e.g. "+3 since yesterday". */
  label: string;
  /** Whether this direction is good news (colours the trend). Defaults to up = positive. */
  positive?: boolean;
}

export interface MetricCardProps {
  label: string;
  value: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  trend?: MetricTrend;
  /** Makes the whole card a link (e.g. to a filtered list). */
  href?: string;
  isLoading?: boolean;
  className?: string;
}

const TREND_ICONS = { up: ArrowUpRight, down: ArrowDownRight, flat: Minus } as const;

export function MetricCard({ label, value, description, icon: Icon, trend, href, isLoading, className }: MetricCardProps) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-muted-foreground text-sm font-medium">{label}</p>
        {Icon ? (
          <span className="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-lg" aria-hidden="true">
            <Icon className="size-4" />
          </span>
        ) : null}
      </div>
      {isLoading ? (
        <Skeleton className="mt-3 h-8 w-20" />
      ) : (
        <p className="text-foreground mt-2 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
      )}
      {trend && !isLoading ? <TrendLine trend={trend} /> : null}
      {description && !isLoading ? <p className="text-muted-foreground mt-1 text-xs">{description}</p> : null}
    </>
  );

  const classes = cn(
    "bg-card text-card-foreground block rounded-xl border p-5 shadow-xs transition-colors",
    href && "hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]",
    className,
  );

  if (href) {
    return (
      <Link href={href} className={classes} aria-busy={isLoading || undefined}>
        {body}
      </Link>
    );
  }
  return (
    <div className={classes} aria-busy={isLoading || undefined}>
      {body}
    </div>
  );
}

function TrendLine({ trend }: { trend: MetricTrend }) {
  const Icon = TREND_ICONS[trend.direction];
  const positive = trend.positive ?? trend.direction === "up";
  const tone =
    trend.direction === "flat"
      ? "text-muted-foreground"
      : positive
        ? "text-emerald-700 dark:text-emerald-400"
        : "text-red-700 dark:text-red-400";
  return (
    <p className={cn("mt-2 flex items-center gap-1 text-xs font-medium", tone)}>
      <Icon className="size-3.5" aria-hidden="true" />
      <span>{trend.label}</span>
    </p>
  );
}
