import type { Metadata } from "next";
import { FLOW, HOW_IT_WORKS_STRIP } from "@/components/marketing/marketing-content";
import {
  CtaBand,
  PageIntro,
  PageSection,
  SectionHeading,
  StepNumber,
} from "@/components/marketing/marketing-sections";
import { StatusBadge } from "@/components/status/status-badge";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "From publishing a Work Policy to the shift ending: how Work Mode connects a phone, follows the schedule, shields distractions, relaxes for breaks and lifts again.",
};

const ACTOR_TONE: Record<(typeof FLOW)[number]["actor"], string> = {
  Manager: "bg-primary/10 text-primary",
  Employee: "bg-emerald-600/10 text-emerald-700 dark:text-emerald-400",
  "Work Mode": "bg-muted text-muted-foreground",
};

export default function HowItWorksPage() {
  return (
    <>
      <PageIntro
        eyebrow="How it works"
        title="Policy, phone, schedule. Then every shift takes care of itself."
        lead="Managers set the rules and the rota. Employees connect their own iPhone once. From then on the phone's own Screen Time schedule does the work, even with the app closed."
      />

      <PageSection tone="muted" aria-labelledby="summary-title">
        <SectionHeading id="summary-title" title="In three steps" align="center" />
        <ol className="mt-10 grid gap-6 md:grid-cols-3">
          {HOW_IT_WORKS_STRIP.map((step, index) => (
            <li key={step.title} className="bg-card flex gap-4 rounded-xl border p-6 shadow-xs">
              <StepNumber n={index + 1} />
              <div className="space-y-1.5">
                <h3 className="font-semibold">{step.title}</h3>
                <p className="text-muted-foreground text-sm leading-relaxed">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </PageSection>

      <PageSection aria-labelledby="flow-title">
        <SectionHeading
          id="flow-title"
          eyebrow="A shift, start to finish"
          title="What happens, and who does it"
          description="Each step shows the state the phone reports to the dashboard at that moment: the same badge a manager sees."
        />
        <ol className="relative mt-12 space-y-8 border-l pl-10 sm:pl-12">
          {FLOW.map((step, index) => (
            <li key={step.key} id={step.key} className="relative scroll-mt-24">
              <StepNumber
                n={index + 1}
                className="ring-background absolute top-0 -left-[calc(2.5rem+1px)] -translate-x-1/2 ring-4 sm:-left-[calc(3rem+1px)]"
              />
              <div className="bg-card space-y-3 rounded-xl border p-5 shadow-xs sm:p-6">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={ACTOR_TONE[step.actor]}>
                    {step.actor}
                  </Badge>
                  {step.state ? (
                    <StatusBadge kind="workModeState" value={step.state} size="sm" />
                  ) : null}
                </div>
                <h3 className="text-lg font-semibold">{step.title}</h3>
                <p className="text-muted-foreground leading-relaxed">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </PageSection>

      <PageSection tone="muted" aria-labelledby="offline-title">
        <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
          <SectionHeading
            id="offline-title"
            title="Works without signal, and without the app open"
            description="The schedule is applied by iOS itself once it is on the phone, so a basement stockroom or a dead battery bar doesn't matter."
          />
          <dl className="grid gap-4 sm:grid-cols-2">
            {[
              {
                term: "Offline shifts",
                detail:
                  "Upcoming shifts and the policy are synced ahead of time. Shields start and stop on schedule with no connection.",
              },
              {
                term: "Rota changes",
                detail:
                  "A silent push asks the phone to sync within minutes when it is online; otherwise it catches up at its next check-in.",
              },
              {
                term: "Wrong clock",
                detail:
                  "The server measures the phone's clock skew and flags devices that drift, so a shift never silently starts late.",
              },
              {
                term: "Leaving",
                detail:
                  "An employee can leave the workplace from the app at any time. Shields and schedules are removed from the phone immediately.",
              },
            ].map((item) => (
              <div key={item.term} className="bg-card rounded-lg border p-4 shadow-xs">
                <dt className="font-medium">{item.term}</dt>
                <dd className="text-muted-foreground mt-1 text-sm leading-relaxed">
                  {item.detail}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </PageSection>

      <CtaBand source="how-it-works" />
    </>
  );
}
