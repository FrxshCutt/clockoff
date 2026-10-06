import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NAV_ITEMS } from "@/config/navigation";
import { SITE } from "@/config/site";
import { SidebarNav } from "./app-sidebar";
import { SkipLink } from "./skip-link";

describe("SidebarNav (server render)", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <SidebarProvider>
        <SidebarNav organisationName="Harbour Café" />
      </SidebarProvider>
    </TooltipProvider>,
  );

  it("renders one labelled navigation landmark with every route from the config", () => {
    expect(html.match(/<nav aria-label="Main"/g)?.length).toBe(1);
    for (const item of NAV_ITEMS) {
      expect(html, item.title).toMatch(new RegExp(`<a[^>]*href="${item.href}"[^>]*>[\\s\\S]*?${item.title.replace("&", "&amp;")}`));
    }
  });

  it("shows the product, organisation and privacy line", () => {
    expect(html).toContain(SITE.name);
    expect(html).toContain("Harbour Café");
    expect(html).toContain(SITE.privacyLine.replace("'", "&#x27;"));
  });
});

describe("SkipLink", () => {
  it("targets the main content landmark", () => {
    expect(renderToStaticMarkup(<SkipLink />)).toMatch(/<a href="#main-content"[^>]*>Skip to main content<\/a>/);
  });
});
