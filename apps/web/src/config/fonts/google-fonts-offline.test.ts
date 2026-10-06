import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// Loaded the same way Next's font loader loads it: `require(process.env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES)[url]`.
const require = createRequire(import.meta.url);
const mock = require("./google-fonts-offline.cjs") as Record<string, unknown>;

describe("google-fonts-offline mock", () => {
  it("answers any Google Fonts CSS URL with a stylesheet that has no font files to download", () => {
    const css = mock["https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap"];
    expect(typeof css).toBe("string");
    expect(css).not.toMatch(/url\(|@font-face/);
    expect(String(css).length).toBeGreaterThan(0);
  });

  it("returns nothing for anything else", () => {
    expect(mock["https://example.com/font.css"]).toBeUndefined();
    expect(mock["then"]).toBeUndefined();
  });
});
