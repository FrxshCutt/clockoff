import { PLAN_CONFIG, PLAN_ORDER } from "@workmode/shared/plans";
import { Check, Mail } from "lucide-react";
import Link from "next/link";
import { planHighlights, planLimitLines, salesMailto } from "@/components/billing/plan-cards";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MARKETING_ROUTES } from "./marketing-content";

/**
 * The plan catalogue on the public pricing page, rendered from `PLAN_CONFIG` (@workmode/shared/plans), the
 * same source the dashboard's Billing page and plan enforcement use. There is no self-serve checkout: every
 * plan leads to a demo request or a sales email.
 */
export function PricingPlans() {
  return (
    <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Plans">
      {PLAN_ORDER.map((plan) => {
        const definition = PLAN_CONFIG[plan];
        const enterprise = plan === "ENTERPRISE";
        const demoHref = `${MARKETING_ROUTES.requestDemo}?source=${encodeURIComponent(`pricing-${plan.toLowerCase()}`)}`;
        return (
          <li
            key={plan}
            data-plan={plan}
            className={cn("bg-card flex flex-col gap-5 rounded-xl border p-5 shadow-xs", plan === "BUSINESS" && "border-primary/50 ring-primary/20 ring-1")}
          >
            <div className="space-y-1">
              <h3 className="font-semibold">{definition.name}</h3>
              <p className="text-2xl font-semibold tracking-tight">{definition.priceLabel}</p>
              {!enterprise ? <p className="text-muted-foreground text-xs">Per organisation, billed monthly.</p> : <p className="text-muted-foreground text-xs">Custom contract and invoicing.</p>}
            </div>
            <dl className="space-y-1.5 text-sm">
              {planLimitLines(plan).map((line) => (
                <div key={line.key} className="flex items-start justify-between gap-3">
                  <dt className="text-muted-foreground">{line.label}</dt>
                  <dd className={cn("text-right font-medium", !line.included && "text-muted-foreground font-normal")}>{line.value}</dd>
                </div>
              ))}
            </dl>
            <ul className="flex-1 space-y-2 text-sm">
              {planHighlights(plan).map((feature) => (
                <li key={feature} className="flex gap-2">
                  <Check className="text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
            {enterprise ? (
              <Button asChild variant="outline" className="w-full">
                <a href={salesMailto(`${definition.name} plan`)}>
                  <Mail aria-hidden="true" />
                  Contact sales
                </a>
              </Button>
            ) : (
              <Button asChild variant={plan === "BUSINESS" ? "default" : "outline"} className="w-full">
                <Link href={demoHref}>Request a demo</Link>
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
