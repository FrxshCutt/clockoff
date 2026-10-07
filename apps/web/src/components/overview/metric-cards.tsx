"use client";

import type { StatusTone } from "@clockoff/shared/status/statusMeta";
import type { ComplianceMetrics } from "@clockoff/validation/compliance";
import {
  CircleCheck,
  Clock,
  Coffee,
  Hourglass,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  Users,
  type LucideIcon,
} from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { METRIC_CARDS, metricHref, metricValueTone, type MetricIcon } from "./overview-model";

const ICONS: Record<MetricIcon, LucideIcon> = {
  users: Users,
  "circle-check": CircleCheck,
  hourglass: Hourglass,
  "shield-alert": ShieldAlert,
  clock: Clock,
  "shield-check": ShieldCheck,
  coffee: Coffee,
  "triangle-alert": TriangleAlert,
};

/** Value colour per tone (AA on the card background in both themes); zero stays neutral. */
const VALUE_TONE_CLASSES: Record<StatusTone, string> = {
  neutral: "",
  success: "text-emerald-700 dark:text-emerald-400",
  info: "text-sky-700 dark:text-sky-400",
  warning: "text-amber-700 dark:text-amber-400",
  danger: "text-red-700 dark:text-red-400",
};

export interface OverviewMetricsProps {
  metrics: ComplianceMetrics | undefined;
  isLoading?: boolean;
  className?: string;
}

/** The eight compliance metric cards; each links to the list of employees behind the number. */
export function OverviewMetrics({ metrics, isLoading = false, className }: OverviewMetricsProps) {
  return (
    <section
      aria-label="Compliance at a glance"
      className={cn("grid gap-4 sm:grid-cols-2 xl:grid-cols-4", className)}
    >
      {METRIC_CARDS.map((card) => {
        const value = metrics?.[card.key];
        const tone: StatusTone = value === undefined ? "neutral" : metricValueTone(card.key, value);
        return (
          <MetricCard
            key={card.key}
            label={card.label}
            description={card.description}
            icon={ICONS[card.icon]}
            href={metricHref(card.key)}
            isLoading={isLoading || value === undefined}
            value={
              <span data-metric={card.key} data-tone={tone} className={VALUE_TONE_CLASSES[tone]}>
                {value === undefined ? "—" : formatNumber(value)}
              </span>
            }
          />
        );
      })}
    </section>
  );
}
