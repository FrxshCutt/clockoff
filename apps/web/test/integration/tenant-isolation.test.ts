import { readdirSync } from "node:fs";
import path from "node:path";
import { defineTenantIsolationSuite } from "../helpers/tenantIsolation";

/**
 * Runs every case registered by the modules in `./tenantCases/` — adding a file there is enough.
 * See docs/TESTING.md → "Adding tenant isolation cases".
 */
const casesDir = path.join(import.meta.dirname, "tenantCases");
const caseFiles = readdirSync(casesDir)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
  .sort();
for (const file of caseFiles) {
  await import(path.join(casesDir, file));
}

defineTenantIsolationSuite();
