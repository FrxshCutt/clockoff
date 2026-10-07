import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PLANS } from "@clockoff/shared/enums";
import { PLAN_CONFIG } from "@clockoff/shared/plans";
import { DEVICE_TO_SERVER_ALLOWED_FIELDS } from "@clockoff/shared/privacyStatements";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SITE } from "@/config/site";
import { HeroIllustration } from "./hero-illustration";
import { FOOTER_GROUPS, MARKETING_NAV } from "./marketing-content";
import { MarketingFooter } from "./marketing-footer";
import { MarketingHeader } from "./marketing-header";
import { CtaBand, PageIntro } from "./marketing-sections";
import { PricingPlans } from "./pricing-plans";
import { PrivacyAllowedFields, integrationsPrivacyStatement } from "./privacy-allowed-fields";
import { RequestDemoForm } from "./request-demo-form";

/** Server-render the marketing building blocks (node, no DOM) and check the copy and structure they emit. */

function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&#x27;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

describe("marketing chrome", () => {
  it("header links every nav item plus log in and the demo CTA", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MarketingHeader />
      </TooltipProvider>,
    );
    for (const item of MARKETING_NAV) expect(html).toContain(`href="${item.href}"`);
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/request-demo"');
    expect(html).toContain('aria-label="Open menu"');
  });

  it("footer renders each link group and the privacy line", () => {
    const html = renderToStaticMarkup(<MarketingFooter />);
    for (const group of FOOTER_GROUPS) {
      expect(html).toContain(`aria-label="${group.title}"`);
      for (const link of group.links) expect(html).toContain(`href="${escape(link.href)}"`);
    }
    expect(html).toContain(escape(SITE.privacyLine));
  });

  it("page intro and CTA band carry the demo source through", () => {
    const intro = renderToStaticMarkup(
      <PageIntro eyebrow="Eyebrow" title="Title here" lead="Lead text." />,
    );
    expect(intro).toMatch(/<h1[^>]*>Title here<\/h1>/);
    const band = renderToStaticMarkup(<CtaBand source="pricing" />);
    expect(band).toContain('href="/request-demo?source=pricing"');
    expect(band).toContain(escape(SITE.privacyLine));
  });

  it("hero illustration is decorative", () => {
    const html = renderToStaticMarkup(<HeroIllustration />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("Work Mode on");
  });
});

describe("pricing plans", () => {
  it("renders every plan from PLAN_CONFIG with its price, and sales contact only for Enterprise", () => {
    const html = renderToStaticMarkup(<PricingPlans />);
    for (const plan of PLANS) {
      expect(html).toContain(`data-plan="${plan}"`);
      expect(html).toContain(escape(PLAN_CONFIG[plan].name));
      expect(html).toContain(escape(PLAN_CONFIG[plan].priceLabel));
    }
    expect((html.match(/Contact sales/g) ?? []).length).toBe(1);
    expect(html).toContain('href="/request-demo?source=pricing-business"');
    expect(html).toContain(`mailto:${SITE.supportEmail}`);
  });
});

describe("privacy page pieces", () => {
  it("lists every allowed device field group with its wire field names", () => {
    const html = renderToStaticMarkup(<PrivacyAllowedFields />);
    for (const group of DEVICE_TO_SERVER_ALLOWED_FIELDS) {
      expect(html).toContain(`data-key="${group.key}"`);
      expect(html).toContain(escape(group.label));
      for (const field of group.fields)
        expect(html).toContain(
          `<code class="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">${field}</code>`,
        );
    }
  });

  it("never claims an integration sync exists while every provider is coming soon", () => {
    expect(integrationsPrivacyStatement()).toContain("not available yet");
    expect(integrationsPrivacyStatement()).toContain("Planday");
  });
});

describe("request demo form", () => {
  it("renders the labelled fields, a hidden honeypot and a submit button", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <RequestDemoForm source="pricing" />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    for (const label of [
      "Your name",
      "Work email",
      "Company",
      "Team size",
      "What would you like to see?",
    ])
      expect(html).toContain(label);
    expect(html).toMatch(
      /<input[^>]*name="email"[^>]*type="email"|<input[^>]*type="email"[^>]*name="email"/,
    );
    expect(html).toMatch(/<input[^>]*id="request-demo-website"[^>]*tabindex="-1"/);
    // Class order is Prettier/Tailwind-sorted, so match the honeypot wrapper by its classes, not their order.
    expect(html).toMatch(
      /<div aria-hidden="true" class="[^"]*\babsolute\b[^"]*-left-\[9999px\][^"]*">/,
    );
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>[\s\S]*?Request a demo/);
    expect(html).not.toContain("Thanks, we");
  });
});
