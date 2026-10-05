#!/usr/bin/env node
// Copies .env.example -> .env (if missing) and fills in generated secrets.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = resolve(root, ".env");
if (existsSync(target)) {
  console.log(".env already exists — leaving it untouched.");
  process.exit(0);
}
let content = readFileSync(resolve(root, ".env.example"), "utf8");
const hex = () => randomBytes(32).toString("hex");
content = content
  .replace('SESSION_SECRET="replace-with-64-hex-chars"', `SESSION_SECRET="${hex()}"`)
  .replace('MOBILE_JWT_SECRET="replace-with-64-hex-chars"', `MOBILE_JWT_SECRET="${hex()}"`)
  .replace(
    'INTEGRATION_ENCRYPTION_KEY="replace-with-base64-32-bytes"',
    `INTEGRATION_ENCRYPTION_KEY="${randomBytes(32).toString("base64")}"`,
  )
  .replace('CRON_SECRET="replace-with-random-string"', `CRON_SECRET="${hex()}"`);
writeFileSync(target, content);
console.log("Created .env with generated secrets.");
