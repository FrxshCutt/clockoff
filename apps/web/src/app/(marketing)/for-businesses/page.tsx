import { CircleAlert, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import { USE_CASES } from "@/components/marketing/marketing-content";
import { CtaBand, PageIntro, PageSection, SectionHeading } from "@/components/marketing/marketing-sections";

export const metadata: Metadata = {
  title: "For businesses",
  description: "How hospitality, retail and warehouse teams use Work Mode to keep phones out of service, off the shop floor and away from the loading bay.",
};

const ROLLOUT = [
  { title: "Pilot one site", body: "Start with a single location or team. Most pilots are live within a shift: a policy, a few employees, the week's rota." },
  { title: "Agree the rules with the team", body: "Share what will pause, what stays available and how breaks work. Work Mode is built to make agreed rules effortless, not to impose them." },
  { title: "Roll out by location", body: "Each site gets its own time zone, policy and break rules where they differ. Head office sees status across all of them." },
] as const;

export default function ForBusinessesPage() {
  return (
    <>
      <PageIntro
        eyebrow="For businesses"
        title="Built for teams on their feet."
        lead="Hospitality, retail, warehouses and logistics share the same problem: phones out at the wrong moment. Work Mode fixes the moment, not the person."
      />

      <PageSection aria-label="Use cases">
        <ul className="grid gap-6 lg:grid-cols-3">
          {USE_CASES.map(({ icon: Icon, title, headline, pains, outcome }) => (
            <li key={title} id={title.toLowerCase().replace(/[^a-z0-9]+/g, "-")} className="bg-card flex flex-col gap-5 rounded-xl border p-6 shadow-xs">
              <div className="space-y-3">
                <span className="bg-primary/10 text-primary flex size-11 items-center justify-center rounded-lg" aria-hidden="true">
                  <Icon className="size-5" />
                </span>
                <h2 className="text-xl font-semibold">{title}</h2>
                <p className="text-muted-foreground text-pretty">{headline}</p>
              </div>
              <div className="space-y-2">
                <h3 className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wide uppercase">
                  <CircleAlert className="size-3.5" aria-hidden="true" />
                  Sound familiar?
                </h3>
                <ul className="space-y-1.5 text-sm">
                  {pains.map((pain) => (
                    <li key={pain} className="flex gap-2">
                      <span className="bg-muted-foreground/60 mt-2 size-1.5 shrink-0 rounded-full" aria-hidden="true" />
                      <span>{pain}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="bg-muted/50 mt-auto space-y-1.5 rounded-lg p-4">
                <h3 className="text-primary flex items-center gap-1.5 text-xs font-medium tracking-wide uppercase">
                  <Sparkles className="size-3.5" aria-hidden="true" />
                  With Work Mode
                </h3>
                <p className="text-sm leading-relaxed">{outcome}</p>
              </div>
            </li>
          ))}
        </ul>
      </PageSection>

      <PageSection tone="muted" aria-labelledby="rollout-title">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.4fr] lg:gap-16">
          <SectionHeading
            id="rollout-title"
            eyebrow="Rolling out"
            title="Start small, keep what works"
            description="No company phones, no MDM and no IT project. Employees use their own iPhone with their consent."
          />
          <ol className="space-y-4">
            {ROLLOUT.map((step, index) => (
              <li key={step.title} className="bg-card flex gap-4 rounded-xl border p-5 shadow-xs">
                <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold tabular-nums" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="space-y-1">
                  <h3 className="font-semibold">{step.title}</h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </PageSection>

      <CtaBand source="for-businesses" title="Talk us through your floor" description="Tell us how your shifts run and we'll show Work Mode on a rota like yours." />
    </>
  );
}
