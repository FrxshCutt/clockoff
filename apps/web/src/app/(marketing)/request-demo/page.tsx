import { CalendarClock, Clock, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { Container } from "@/components/marketing/marketing-sections";
import { RequestDemoForm } from "@/components/marketing/request-demo-form";
import { normaliseDemoSource } from "@/components/marketing/request-demo-schema";
import { SITE } from "@/config/site";

export const metadata: Metadata = {
  title: "Request a demo",
  description: "Book a 20-minute walkthrough of Work Mode on a rota like yours.",
  robots: { index: true, follow: true },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const EXPECT = [
  {
    icon: Clock,
    title: "20 minutes",
    body: "A short screen share: policies, break rules, a rota and what the employee sees on their iPhone.",
  },
  {
    icon: CalendarClock,
    title: "Your rota, your questions",
    body: "Bring a real week and we'll walk through it, including how imports and late changes work.",
  },
  {
    icon: ShieldCheck,
    title: "Privacy, in writing",
    body: "We'll show you exactly what managers can and cannot see, from the same statements employees read.",
  },
] as const;

export default async function RequestDemoPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = (await searchParams).source;
  const source = normaliseDemoSource(Array.isArray(raw) ? raw[0] : raw);
  return (
    <Container className="grid gap-12 py-16 sm:py-20 lg:grid-cols-[1fr_1.2fr] lg:gap-16">
      <div className="space-y-8">
        <div className="space-y-4">
          <p className="text-primary text-sm font-semibold tracking-wide uppercase">
            Request a demo
          </p>
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            See Work Mode on your own rota.
          </h1>
          <p className="text-muted-foreground text-lg text-pretty">
            Tell us a little about your team and we&apos;ll arrange a walkthrough. No card, no
            commitment.
          </p>
        </div>
        <ul className="space-y-4">
          {EXPECT.map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex gap-3">
              <span
                className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg"
                aria-hidden="true"
              >
                <Icon className="size-4" />
              </span>
              <div>
                <p className="font-medium">{title}</p>
                <p className="text-muted-foreground text-sm leading-relaxed">{body}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground text-sm">
          Prefer email?{" "}
          <a
            href={`mailto:${SITE.supportEmail}?subject=${encodeURIComponent("Work Mode demo")}`}
            className="hover:text-foreground underline underline-offset-4"
          >
            {SITE.supportEmail}
          </a>
        </p>
      </div>
      <RequestDemoForm source={source} />
    </Container>
  );
}
