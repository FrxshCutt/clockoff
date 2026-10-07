import { DEVICE_STATUS_BADGES } from "@clockoff/shared/enums";
import { Check } from "lucide-react";
import type { Metadata } from "next";
import { PRODUCT_SECTIONS } from "@/components/marketing/marketing-content";
import {
  CtaBand,
  PageIntro,
  PageSection,
  SectionHeading,
} from "@/components/marketing/marketing-sections";
import { StatusBadge } from "@/components/status/status-badge";

export const metadata: Metadata = {
  title: "Product",
  description:
    "Work Policies, Break Rules, scheduling, CSV import and live device status: how ClockOff turns a rota into distraction-free shifts on iPhone.",
};

export default function ProductPage() {
  return (
    <>
      <PageIntro
        eyebrow="Product"
        title="A rota in, distraction-free shifts out."
        lead="ClockOff sits between the schedule you already keep and the phones in your team's pockets. Set the rules once; every shift applies them."
      />

      {PRODUCT_SECTIONS.map((section, index) => (
        <PageSection
          key={section.id}
          id={section.id}
          tone={index % 2 === 1 ? "muted" : "default"}
          aria-labelledby={`${section.id}-title`}
        >
          <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr] lg:gap-16">
            <SectionHeading
              id={`${section.id}-title`}
              title={section.title}
              description={section.body}
            />
            <ul className="space-y-3">
              {section.points.map((point) => (
                <li
                  key={point}
                  className="bg-card flex gap-3 rounded-lg border p-4 text-sm leading-relaxed shadow-xs"
                >
                  <Check className="text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span>{point}</span>
                </li>
              ))}
              {section.id === "status" ? (
                <li className="bg-card rounded-lg border p-4 shadow-xs">
                  <p className="text-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase">
                    Every badge a manager can see
                  </p>
                  <ul className="flex flex-wrap gap-2" aria-label="Device status badges">
                    {DEVICE_STATUS_BADGES.map((badge) => (
                      <li key={badge}>
                        <StatusBadge kind="deviceStatus" value={badge} />
                      </li>
                    ))}
                  </ul>
                </li>
              ) : null}
            </ul>
          </div>
        </PageSection>
      ))}

      <CtaBand source="product" />
    </>
  );
}
