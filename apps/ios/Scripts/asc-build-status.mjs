#!/usr/bin/env node
// Report (and optionally wait for) the App Store Connect processing state of an uploaded build.
// Usage: node Scripts/asc-build-status.mjs --key <AuthKey_X.p8> --key-id <id> --issuer <issuer-uuid>
//          --bundle-id online.clockoff.app --build <CFBundleVersion> [--wait] [--timeout-minutes 45]
// Uses an App Store Connect API key (ES256 JWT, 20-minute lifetime). Prints no key material.
import crypto from "node:crypto";
import fs from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith("--")) pairs.push([arg.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return pairs;
  }, []),
);
for (const required of ["key", "key-id", "issuer", "bundle-id", "build"]) {
  if (!args[required] || args[required] === true) throw new Error(`missing --${required}`);
}
const key = crypto.createPrivateKey(fs.readFileSync(args.key));
const b64u = (value) => Buffer.from(value).toString("base64url");
function token() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: "ES256", kid: args["key-id"], typ: "JWT" }));
  const body = b64u(JSON.stringify({ iss: args.issuer, iat: now, exp: now + 1100, aud: "appstoreconnect-v1" }));
  const signature = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64u(signature)}`;
}
async function asc(path) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, { headers: { Authorization: `Bearer ${token()}` } });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`App Store Connect ${response.status}: ${(json.errors ?? []).map((e) => e.title).join("; ")}`);
  return json;
}

const apps = await asc(`/v1/apps?filter[bundleId]=${encodeURIComponent(args["bundle-id"])}&fields[apps]=name,bundleId`);
const app = apps.data?.[0];
if (!app) throw new Error(`No App Store Connect app with bundle id ${args["bundle-id"]}`);
const deadline = Date.now() + Number(args["timeout-minutes"] ?? 45) * 60_000;
let last = "";
for (;;) {
  const builds = await asc(
    `/v1/builds?filter[app]=${app.id}&filter[version]=${encodeURIComponent(args.build)}&fields[builds]=version,processingState,uploadedDate,expired&limit=1`,
  );
  const build = builds.data?.[0];
  const state = build ? build.attributes.processingState : "NOT_FOUND_YET";
  if (state !== last) {
    console.log(`${new Date().toISOString()} ${app.attributes.name} build ${args.build}: ${state}${build?.attributes.uploadedDate ? ` (uploaded ${build.attributes.uploadedDate})` : ""}`);
    last = state;
  }
  const done = ["VALID", "FAILED", "INVALID"].includes(state);
  if (done || !args.wait || Date.now() > deadline) {
    if (!done && args.wait) console.log("Still processing; check App Store Connect → TestFlight later.");
    process.exitCode = state === "FAILED" || state === "INVALID" ? 1 : 0;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}
