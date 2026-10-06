import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { PrivacyExplainer } from "@/components/help/privacy-explainer";
import {
  PRIVACY_DATA_HANDLING,
  PRIVACY_TECH_POINTS,
} from "@/components/marketing/marketing-content";
import {
  CtaBand,
  PageIntro,
  PageSection,
  SectionHeading,
} from "@/components/marketing/marketing-sections";
import {
  PrivacyAllowedFields,
  integrationsPrivacyStatement,
} from "@/components/marketing/privacy-allowed-fields";
import { SITE } from "@/config/site";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What an employer can and cannot see with Work Mode, how the iPhone app uses Apple Screen Time, and the exact fields a phone sends to the server.",
};

const SECTIONS = [
  { id: "how", label: "How it works, technically" },
  { id: "can-cannot", label: "Can and cannot see" },
  { id: "device-sends", label: "What the device sends" },
  { id: "data-handling", label: "Data handling" },
] as const;

export default function PrivacyPage() {
  return (
    <>
      <PageIntro
        eyebrow="Privacy"
        title="Block distractions. Don't monitor employees."
        lead="Work Mode exists to make shift work less distracting, not to watch people. The employer sees operational status only. This page is the authoritative statement of what that means; the same definitions drive the dashboard, the employee app and the mobile API."
      >
        <nav aria-label="On this page">
          <ul className="flex flex-wrap gap-2">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="bg-muted/60 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50 inline-flex h-8 items-center rounded-full px-3 text-sm font-medium outline-none focus-visible:ring-[3px]"
                >
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </PageIntro>

      <PageSection id="how" tone="muted" aria-labelledby="how-title" className="pt-12 sm:pt-16">
        <SectionHeading
          id="how-title"
          title="How it works, technically"
          description="Precisely what the iPhone app does with Apple's Screen Time frameworks, and what that rules out."
        />
        <ol className="mt-10 grid gap-4 md:grid-cols-2">
          {PRIVACY_TECH_POINTS.map((point, index) => (
            <li key={point.title} className="bg-card flex gap-4 rounded-xl border p-5 shadow-xs">
              <span
                className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold tabular-nums"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <div className="space-y-1.5">
                <h3 className="font-semibold">{point.title}</h3>
                <p className="text-muted-foreground text-sm leading-relaxed">{point.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </PageSection>

      <PageSection id="can-cannot" aria-labelledby="privacy-can-see">
        <PrivacyExplainer headingLevel={2} />
      </PageSection>

      <PageSection id="device-sends" tone="muted" aria-labelledby="device-sends-title">
        <SectionHeading
          id="device-sends-title"
          title="What the device sends"
          description="The mobile API accepts only the fields below, by their exact request field names. Request schemas are strict: unknown fields are rejected. Adding a field means changing the shared privacy statements, which regenerates this list, so the allow-list and this page cannot drift apart."
        />
        <div className="mt-10">
          <PrivacyAllowedFields />
        </div>
        <p className="text-muted-foreground mt-4 text-sm">
          Not listed, because they carry no information about the employee or the phone:
          authentication tokens, ids the server itself issued (employee, shift and break ids), and
          structural fields such as the request containers and the date window of a schedule
          request.
        </p>
      </PageSection>

      <PageSection id="data-handling" aria-labelledby="data-handling-title">
        <SectionHeading id="data-handling-title" title="Data handling" />
        <ul className="mt-8 max-w-3xl space-y-3">
          {[...PRIVACY_DATA_HANDLING, integrationsPrivacyStatement()].map((line) => (
            <li key={line} className="flex gap-3 text-sm leading-relaxed">
              <ShieldCheck className="text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground mt-8 max-w-3xl text-sm">
          Questions about privacy? Email{" "}
          <a
            href={`mailto:${SITE.supportEmail}`}
            className="hover:text-foreground underline underline-offset-4"
          >
            {SITE.supportEmail}
          </a>
          .
        </p>
      </PageSection>

      <CtaBand
        source="privacy"
        title="Show your team this page"
        description="Employees read the same statements in the app before they join. Book a demo and bring your questions."
      />
    </>
  );
}
