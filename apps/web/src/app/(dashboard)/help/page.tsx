import { ArrowRight, Mail } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { FaqAccordion } from "@/components/help/faq-accordion";
import { FAQ_ITEMS, HELP_ANCHORS, SUPPORT } from "@/components/help/help-content";
import { PrivacyExplainer } from "@/components/help/privacy-explainer";
import { SetupGuide } from "@/components/help/setup-guide";
import { Troubleshooting } from "@/components/help/troubleshooting";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section";
import { Button } from "@/components/ui/button";
import { ROUTES, routeFor } from "@/config/navigation";

export const metadata: Metadata = { title: "Help" };

const GETTING_STARTED = [
  {
    title: "Create a Work Policy",
    body: "Choose which categories of apps are restricted during shifts.",
    href: ROUTES.policies,
  },
  {
    title: "Set Break Rules",
    body: "Decide how long breaks last and what relaxes during them.",
    href: ROUTES.breakRules,
  },
  {
    title: "Add employees",
    body: "Add everyone who works shifts, using the names they'll type in the app.",
    href: ROUTES.employees,
  },
  {
    title: "Add shifts",
    body: "Create shifts or import your rota so phones know when to switch Work Mode on.",
    href: ROUTES.schedule,
  },
  {
    title: "Share your join code",
    body: "Employees install ClockOff on their iPhone and join with your company code.",
    href: routeFor.settingsTab("join-code"),
  },
] as const;

const SECTIONS = [
  { id: HELP_ANCHORS.gettingStarted, label: "Getting started" },
  { id: HELP_ANCHORS.setup, label: "Employee setup" },
  { id: HELP_ANCHORS.faq, label: "FAQ" },
  { id: HELP_ANCHORS.privacy, label: "Privacy" },
  { id: HELP_ANCHORS.troubleshooting, label: "Troubleshooting" },
  { id: HELP_ANCHORS.support, label: "Support" },
] as const;

const supportHref = `mailto:${SUPPORT.email}?subject=${encodeURIComponent(SUPPORT.subject)}`;

export default function HelpPage() {
  return (
    <>
      <PageHeader
        title="Help"
        description="Get your team set up, understand exactly what Work Mode can and can't see, and fix the problems that come up."
        actions={
          <Button asChild variant="outline">
            <a href={supportHref}>
              <Mail aria-hidden="true" />
              Contact support
            </a>
          </Button>
        }
      />
      <nav aria-label="On this page" className="-mt-2 mb-6">
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
      <div className="space-y-6">
        <div id={HELP_ANCHORS.gettingStarted} className="scroll-mt-20">
          <SectionCard
            title="Getting started"
            description="Five steps from sign-up to your first distraction-free shift."
          >
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
        </div>

        <div id={HELP_ANCHORS.setup} className="scroll-mt-20">
          <SectionCard
            title="Employee setup guide"
            description="What employees see in the ClockOff app on their iPhone, screen by screen, and where you can help."
          >
            <SetupGuide />
          </SectionCard>
        </div>

        <div id={HELP_ANCHORS.faq} className="scroll-mt-20">
          <SectionCard
            title="Frequently asked questions"
            description="Short answers, with links to the right place in the dashboard."
          >
            <FaqAccordion items={FAQ_ITEMS} />
          </SectionCard>
        </div>

        <div id={HELP_ANCHORS.privacy} className="scroll-mt-20">
          <SectionCard
            title="Privacy: what Work Mode can and can't see"
            description="These statements drive the dashboard, the employee app and the mobile API. They are the same ones employees read before joining."
          >
            <PrivacyExplainer />
          </SectionCard>
        </div>

        <div id={HELP_ANCHORS.troubleshooting} className="scroll-mt-20">
          <SectionCard
            title="Troubleshooting"
            description="The three problems that come up most, and how to clear them."
          >
            <Troubleshooting />
          </SectionCard>
        </div>

        <div id={HELP_ANCHORS.support} className="scroll-mt-20">
          <SectionCard
            title="Still stuck?"
            description={SUPPORT.hours}
            footer={
              <Button asChild>
                <a href={supportHref}>
                  <Mail aria-hidden="true" />
                  Email {SUPPORT.email}
                </a>
              </Button>
            }
          >
            <p className="text-muted-foreground mb-2 text-sm">
              To help us answer quickly, include:
            </p>
            <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
              {SUPPORT.include.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </SectionCard>
        </div>
      </div>
    </>
  );
}
