import { CANNOT_SEE, CAN_SEE, EMPLOYEE_PRIVACY_SUMMARY } from "@workmode/shared/privacyStatements";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrivacyExplainer, PrivacyStatementList } from "./privacy-explainer";

function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&#x27;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

describe("PrivacyStatementList", () => {
  it("renders every statement with its label and detail", () => {
    const html = renderToStaticMarkup(<PrivacyStatementList items={CAN_SEE} tone="can" />);
    expect((html.match(/<li /g) ?? []).length).toBe(CAN_SEE.length);
    for (const item of CAN_SEE) {
      expect(html).toContain(`data-key="${item.key}"`);
      expect(html).toContain(escape(item.label));
      expect(html).toContain(escape(item.detail));
    }
  });

  it("limits the list when asked", () => {
    const html = renderToStaticMarkup(
      <PrivacyStatementList items={CANNOT_SEE} tone="cannot" limit={3} />,
    );
    expect((html.match(/<li /g) ?? []).length).toBe(3);
    expect(html).toContain('data-tone="cannot"');
  });
});

describe("PrivacyExplainer", () => {
  it("renders both lists in full and the employee summary", () => {
    const html = renderToStaticMarkup(<PrivacyExplainer />);
    expect((html.match(/<li /g) ?? []).length).toBe(CAN_SEE.length + CANNOT_SEE.length);
    expect(html).toContain("What managers can see");
    expect(html).toContain("What managers can never see");
    expect(html).toContain(escape(EMPLOYEE_PRIVACY_SUMMARY));
    expect(html).toMatch(/<h3[^>]*id="privacy-can-see"/);
  });

  it("uses h2 headings and renders the footer on a bare page", () => {
    const html = renderToStaticMarkup(
      <PrivacyExplainer headingLevel={2} footer={<a href="/privacy">Full statement</a>} />,
    );
    expect(html).toMatch(/<h2[^>]*id="privacy-cannot-see"/);
    expect(html).toContain('href="/privacy"');
  });
});
