import { Mail } from "lucide-react";
import type { Metadata } from "next";
import { salesMailto } from "@/components/billing/plan-cards";
import { FaqAccordion } from "@/components/help/faq-accordion";
import { PRICING_FAQ } from "@/components/marketing/marketing-content";
import {
  CtaBand,
  PageIntro,
  PageSection,
  SectionHeading,
} from "@/components/marketing/marketing-sections";
import { PricingPlans } from "@/components/marketing/pricing-plans";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Starter, Business, Pro and Enterprise plans for ClockOff, sized by employees, locations and integrations. Set up with our team; no card needed.",
};

const FAQ_ITEMS = PRICING_FAQ.map((item, index) => ({
  id: `pricing-faq-${index + 1}`,
  question: item.question,
  answer: item.answer,
}));

export default function PricingPage() {
  return (
    <>
      <PageIntro
        eyebrow="Pricing"
        title="Simple plans, set up with a person."
        lead="Every plan includes Work Policies, Break Rules, scheduling and live device status. Pick the size that fits; we'll set it up with you. There's no card to enter and no self-serve checkout yet."
      >
        <Button asChild variant="outline">
          <a href={salesMailto("ClockOff pricing")}>
            <Mail aria-hidden="true" />
            Contact sales
          </a>
        </Button>
      </PageIntro>

      <PageSection aria-label="Plans" className="pt-0 sm:pt-0">
        <PricingPlans />
        <p className="text-muted-foreground mt-6 text-sm">
          Prices exclude VAT. Rota integrations are listed on the plans that will include them and
          are coming soon; CSV import is available on every plan today.
        </p>
      </PageSection>

      <PageSection tone="muted" aria-labelledby="pricing-faq-title">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr] lg:gap-16">
          <SectionHeading
            id="pricing-faq-title"
            title="Questions about plans"
            description="Anything else, ask us during the demo or email sales."
          />
          <FaqAccordion items={FAQ_ITEMS} className="bg-card rounded-xl border px-5 shadow-xs" />
        </div>
      </PageSection>

      <CtaBand
        source="pricing"
        title="Not sure which plan?"
        description="Book a demo and we'll recommend one from your headcount and sites, with no commitment."
      />
    </>
  );
}
