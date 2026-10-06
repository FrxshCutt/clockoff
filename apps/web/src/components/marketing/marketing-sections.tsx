import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SITE } from "@/config/site";
import { cn } from "@/lib/utils";
import { MARKETING_CTA, MARKETING_ROUTES } from "./marketing-content";

/** Layout primitives shared by the public pages. All server components. */

export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-6xl px-4 sm:px-6", className)}>{children}</div>;
}

export interface PageIntroProps {
  eyebrow?: string;
  title: string;
  lead?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** The `<h1>` block at the top of every inner page. */
export function PageIntro({ eyebrow, title, lead, children, className }: PageIntroProps) {
  return (
    <Container className={cn("py-16 sm:py-20", className)}>
      <div className="max-w-3xl space-y-5">
        {eyebrow ? <p className="text-primary text-sm font-semibold tracking-wide uppercase">{eyebrow}</p> : null}
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">{title}</h1>
        {lead ? <p className="text-muted-foreground text-lg text-pretty sm:text-xl">{lead}</p> : null}
        {children}
      </div>
    </Container>
  );
}

export interface SectionHeadingProps {
  id?: string;
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  align?: "start" | "center";
  className?: string;
}

export function SectionHeading({ id, eyebrow, title, description, align = "start", className }: SectionHeadingProps) {
  return (
    <div className={cn("max-w-2xl space-y-3", align === "center" && "mx-auto text-center", className)}>
      {eyebrow ? <p className="text-primary text-sm font-semibold tracking-wide uppercase">{eyebrow}</p> : null}
      <h2 id={id} className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
        {title}
      </h2>
      {description ? <p className="text-muted-foreground text-base text-pretty sm:text-lg">{description}</p> : null}
    </div>
  );
}

export interface PageSectionProps {
  id?: string;
  /** `muted` draws a soft band behind the section. */
  tone?: "default" | "muted";
  children: ReactNode;
  className?: string;
  "aria-labelledby"?: string;
  "aria-label"?: string;
}

export function PageSection({ id, tone = "default", children, className, ...aria }: PageSectionProps) {
  return (
    <section id={id} {...aria} className={cn("scroll-mt-20 py-16 sm:py-20", tone === "muted" && "bg-muted/40 border-y", className)}>
      <Container>{children}</Container>
    </section>
  );
}

export interface CtaBandProps {
  title?: string;
  description?: string;
  /** Appended to the demo link as `?source=` so the request records where it came from. */
  source: string;
}

/** Closing call to action used at the bottom of every page. */
export function CtaBand({ title = "See it on your own rota", description = "A 20-minute walkthrough with your shifts, your policies and your questions.", source }: CtaBandProps) {
  return (
    <section aria-labelledby="cta-band-title" className="py-16 sm:py-20">
      <Container>
        <div className="bg-primary text-primary-foreground relative overflow-hidden rounded-2xl px-6 py-12 sm:px-12 sm:py-16">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(40rem_20rem_at_80%_0%,color-mix(in_oklch,white_22%,transparent),transparent)]"
          />
          <div className="relative flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-xl space-y-3">
              <h2 id="cta-band-title" className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
                {title}
              </h2>
              <p className="text-primary-foreground/85 text-pretty">{description}</p>
              <p className="text-primary-foreground/85 text-sm font-medium">{SITE.privacyLine}</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg" variant="secondary">
                <Link href={`${MARKETING_ROUTES.requestDemo}?source=${encodeURIComponent(source)}`}>
                  {MARKETING_CTA.primary.label}
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="ghost" className="text-primary-foreground hover:bg-white/10 hover:text-primary-foreground">
                <Link href={MARKETING_CTA.login.href}>{MARKETING_CTA.login.label}</Link>
              </Button>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}

/** Numbered step marker used by the how-it-works strip and flow. */
export function StepNumber({ n, className }: { n: number; className?: string }) {
  return (
    <span
      className={cn("bg-primary text-primary-foreground flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold tabular-nums", className)}
      aria-hidden="true"
    >
      {n}
    </span>
  );
}
