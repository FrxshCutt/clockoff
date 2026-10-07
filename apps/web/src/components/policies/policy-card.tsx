import type { Policy } from "@clockoff/validation/policies";
import { Star, Users } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { StatusBadge } from "@/components/status/status-badge";
import { Badge } from "@/components/ui/badge";
import { routeFor } from "@/config/navigation";
import type { DateInput } from "@/lib/format";
import { cn } from "@/lib/utils";
import { categoryLabels, formatAssignedSummary, formatVersionLabel } from "./policy-view-model";

export interface PolicyCardProps {
  policy: Policy;
  /** Top-right menu (rendered by the parent so the card stays presentational). */
  actions?: ReactNode;
  /** Reference instant for relative labels; defaults to now. */
  now?: DateInput;
  className?: string;
}

const MAX_VISIBLE_CATEGORIES = 4;

/**
 * One Work Policy in the grid: name, status, categories, who it applies to and the version line. The category
 * chips come from the published version (what devices enforce); only a never-published draft shows its draft.
 */
export function PolicyCard({ policy, actions, now, className }: PolicyCardProps) {
  const version = policy.currentVersion ?? policy.draftVersion;
  const labels = version ? categoryLabels(version.restrictionConfig.categories) : [];
  const visible = labels.slice(0, MAX_VISIBLE_CATEGORIES);
  const hidden = labels.length - visible.length;
  const headingId = `policy-card-${policy.id}`;

  return (
    <article
      aria-labelledby={headingId}
      data-policy-id={policy.id}
      className={cn(
        "bg-card text-card-foreground relative flex flex-col gap-4 rounded-xl border p-5 shadow-xs transition-colors",
        "has-[a:focus-visible]:ring-ring/50 hover:border-primary/40 has-[a:focus-visible]:ring-[3px]",
        policy.status === "ARCHIVED" && "opacity-75",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <h2 id={headingId} className="min-w-0 text-base font-semibold tracking-tight">
            <Link
              href={routeFor.policy(policy.id)}
              className="line-clamp-2 outline-none after:absolute after:inset-0 after:rounded-xl after:content-['']"
            >
              {policy.name}
            </Link>
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge kind="policyStatus" value={policy.status} size="sm" />
            {policy.isDefault ? (
              <Badge
                variant="secondary"
                className="gap-1 font-normal"
                title="Applies to everyone without a more specific assignment"
              >
                <Star className="fill-amber-400 text-amber-500" aria-hidden="true" />
                Default
              </Badge>
            ) : null}
          </div>
        </div>
        {actions ? <div className="relative z-10 shrink-0">{actions}</div> : null}
      </div>

      {policy.description ? (
        <p className="text-muted-foreground line-clamp-2 text-sm">{policy.description}</p>
      ) : null}

      <ul className="flex flex-wrap gap-1.5" aria-label="Restricted categories">
        {visible.map((label) => (
          <li key={label}>
            <Badge variant="outline" className="font-normal">
              {label}
            </Badge>
          </li>
        ))}
        {hidden > 0 ? (
          <li>
            <Badge
              variant="outline"
              className="text-muted-foreground font-normal"
              title={labels.slice(MAX_VISIBLE_CATEGORIES).join(", ")}
            >
              +{hidden} more
            </Badge>
          </li>
        ) : null}
        {labels.length === 0 ? (
          <li className="text-muted-foreground text-xs">No categories yet</li>
        ) : null}
      </ul>

      <div className="text-muted-foreground mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t pt-3 text-xs">
        <span className="inline-flex items-center gap-1.5">
          <Users className="size-3.5" aria-hidden="true" />
          {formatAssignedSummary(policy)}
        </span>
        <span className="tabular-nums">{formatVersionLabel(policy, now)}</span>
      </div>
    </article>
  );
}
