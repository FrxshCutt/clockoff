import { ArrowRight, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PrivacyExplainer } from "@/components/help/privacy-explainer";
import { HeroIllustration } from "@/components/marketing/hero-illustration";
import {
  FEATURES,
  HERO,
  HOW_IT_WORKS_STRIP,
  MARKETING_CTA,
  MARKETING_ROUTES,
} from "@/components/marketing/marketing-content";
import {
  Container,
  CtaBand,
  PageSection,
  SectionHeading,
  StepNumber,
} from "@/components/marketing/marketing-sections";
import { Button } from "@/components/ui/button";
import { SITE } from "@/config/site";

export const metadata: Metadata = {
  title: { absolute: `${SITE.name} · ${SITE.tagline}` },
  description: SITE.description,
};

export default function HomePage() {
  return (
    <>
      <section aria-labelledby="hero-title" className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60rem_30rem_at_20%_-10%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent)]"
        />
        <Container className="grid items-center gap-12 py-16 sm:py-24 lg:grid-cols-[1.1fr_1fr]">
          <div className="max-w-2xl space-y-6">
            <p className="text-primary inline-flex items-center gap-2 text-sm font-semibold tracking-wide uppercase">
              <ShieldCheck className="size-4" aria-hidden="true" />
              {HERO.privacyLine}
            </p>
            <h1
              id="hero-title"
              className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl"
            >
              {HERO.headline}
            </h1>
            <p className="text-muted-foreground text-lg text-pretty sm:text-xl">
              {HERO.subheadline}
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link href={`${MARKETING_CTA.primary.href}?source=home`}>
                  {MARKETING_CTA.primary.label}
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href={HERO.secondaryCta.href}>{HERO.secondaryCta.label}</Link>
              </Button>
            </div>
            <p className="text-muted-foreground text-sm">{HERO.platformNote}</p>
          </div>
          <HeroIllustration className="max-w-xl justify-self-center lg:justify-self-end" />
        </Container>
      </section>

      <PageSection tone="muted" aria-labelledby="how-title">
        <SectionHeading
          id="how-title"
          eyebrow="How it works"
          title="Three steps, then it runs itself"
          align="center"
        />
        <ol className="mt-12 grid gap-6 md:grid-cols-3">
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
        <div className="mt-8 text-center">
          <Button asChild variant="link">
            <Link href={MARKETING_ROUTES.howItWorks}>
              The full flow, shift by shift
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </PageSection>

      <PageSection aria-labelledby="features-title">
        <SectionHeading
          id="features-title"
          eyebrow="Product"
          title="Everything a shift needs, nothing it doesn't"
          description="Policies, break rules, scheduling and live status, designed for teams on their feet."
        />
        <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <li key={title} className="bg-card rounded-xl border p-6 shadow-xs">
              <span
                className="bg-primary/10 text-primary mb-4 flex size-10 items-center justify-center rounded-lg"
                aria-hidden="true"
              >
                <Icon className="size-5" />
              </span>
              <h3 className="font-semibold">{title}</h3>
              <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{body}</p>
            </li>
          ))}
        </ul>
        <div className="mt-8">
          <Button asChild variant="link" className="px-0">
            <Link href={MARKETING_ROUTES.product}>
              Explore the product
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </PageSection>

      <PageSection tone="muted" aria-labelledby="privacy-title">
        <SectionHeading
          id="privacy-title"
          eyebrow="Privacy"
          title="Operational status only. Never surveillance."
          description="The same statements drive the dashboard, the employee app and the mobile API, so what we promise is what the software can do."
        />
        <div className="mt-12">
          <PrivacyExplainer
            headingLevel={3}
            limit={4}
            footer={
              <Button asChild variant="outline">
                <Link href={MARKETING_ROUTES.privacy}>
                  Read the full privacy statement
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
            }
          />
        </div>
      </PageSection>

      <CtaBand source="home" />
    </>
  );
}
