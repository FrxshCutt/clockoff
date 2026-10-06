import { CANNOT_SEE, CAN_SEE } from "@workmode/shared/privacyStatements";
import { ArrowRight, Check, Mail, X } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section";
import { Button } from "@/components/ui/button";
import { ROUTES, routeFor } from "@/config/navigation";
import { SITE } from "@/config/site";

export const metadata: Metadata = { title: "Help" };

const GETTING_STARTED = [
  { title: "Create a Work Policy", body: "Choose which categories of apps are restricted during shifts.", href: ROUTES.policies },
  { title: "Set Break Rules", body: "Decide how long breaks last and what relaxes during them.", href: ROUTES.breakRules },
  { title: "Add employees", body: "Add everyone who works shifts, using the names they'll type in the app.", href: ROUTES.employees },
  { title: "Add shifts", body: "Create shifts or import your rota so phones know when to switch Work Mode on.", href: ROUTES.schedule },
  {
    title: "Share your join code",
    body: "Employees install Work Mode on their iPhone and join with your company code.",
    href: routeFor.settingsTab("join-code"),
  },
] as const;

export default function HelpPage() {
  return (
    <>
      <PageHeader
        title="Help"
        description="Get your team set up, and understand exactly what Work Mode can and can't see."
        actions={
          <Button asChild variant="outline">
            <a href={`mailto:${SITE.supportEmail}`}>
              <Mail aria-hidden="true" />
              Contact support
            </a>
          </Button>
        }
      />
      <div className="space-y-6">
        <SectionCard title="Getting started" description="Five steps from sign-up to your first distraction-free shift.">
          <ol className="divide-y">
            {GETTING_STARTED.map((step, index) => (
              <li key={step.title}>
                <Link
                  href={step.href}
                  className="hover:bg-accent/50 focus-visible:ring-ring/50 group -mx-2 flex items-center gap-4 rounded-lg px-2 py-3 outline-none focus-visible:ring-[3px]"
                >
                  <span className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold tabular-nums">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{step.title}</span>
                    <span className="text-muted-foreground block text-sm">{step.body}</span>
                  </span>
                  <ArrowRight
                    className="text-muted-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </Link>
              </li>
            ))}
          </ol>
        </SectionCard>
        <div className="grid gap-6 lg:grid-cols-2">
          <SectionCard title="What managers can see" description="Operational status only.">
            <ul className="space-y-3">
              {CAN_SEE.map((item) => (
                <li key={item.key} className="flex gap-3 text-sm">
                  <Check className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                  <span>
                    <span className="block font-medium">{item.label}</span>
                    <span className="text-muted-foreground block">{item.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </SectionCard>
          <SectionCard title="What managers can never see" description={SITE.privacyLine}>
            <ul className="space-y-3">
              {CANNOT_SEE.map((item) => (
                <li key={item.key} className="flex gap-3 text-sm">
                  <X className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span>
                    <span className="block font-medium">{item.label}</span>
                    <span className="text-muted-foreground block">{item.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
      </div>
    </>
  );
}
