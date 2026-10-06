import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ERROR_HTTP_STATUS, type ApiErrorCode } from "@workmode/shared/errors";
import { isoDateTimeSchema, timezoneSchema } from "../common";
import { apiErrorResponseSchema, queryBooleanSchema } from "../primitives";
import "./routes";
import {
  csrfRequired,
  operationIdOf,
  registry,
  toOpenApiPath,
  type HttpMethod,
  type RouteDefinition,
  type RouteResponse,
  type RouteResponseContent,
} from "./registry";

/**
 * OpenAPI 3.1 generator (D-008). Converts every registered route's Zod schemas with `z.toJSONSchema`
 * (JSON Schema 2020-12, which OpenAPI 3.1 uses natively) and writes `docs/openapi.json`.
 *
 * - Request schemas are converted with `io: "input"` (what clients send: defaults are optional, query
 *   strings are strings), response schemas with `io: "output"` (what the server returns).
 * - Every schema with `.meta({ id })` becomes `#/components/schemas/<id>`. When an id's input and output
 *   shapes differ (e.g. a field with a default), the input variant is published as `<id>Input`.
 * - Response objects are open (no `additionalProperties: false` unless the Zod object is strict): clients
 *   must ignore unknown fields so new response fields are non-breaking. Request bodies are strict.
 * - Output is deterministic: paths, methods, components and tags are emitted in a fixed order.
 *
 * Run: `pnpm --filter @workmode/validation openapi` (or `pnpm openapi` at the root).
 */

export type JsonSchema = { [key: string]: unknown };
type IoMode = "input" | "output";

export const OPENAPI_VERSION = "3.1.0";
export const API_DOC_VERSION = "0.1.0";
export const OPENAPI_OUTPUT_PATH = fileURLToPath(
  new URL("../../../../docs/openapi.json", import.meta.url),
);

const COMPONENT_REF_PREFIX = "#/components/schemas/";
const DEFS_REF_PREFIX = "#/$defs/";
const METHOD_ORDER: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const FORMATS_WITHOUT_PATTERN: ReadonlySet<string> = new Set([
  "uuid",
  "email",
  "date",
  "date-time",
]);

export const TAG_DESCRIPTIONS: Readonly<Record<string, string>> = {
  Activity: "Operational activity feed (no device content).",
  "Audit logs": "Who changed what — manager actions only.",
  Auth: "Manager accounts: sign-up, sign-in, email verification, passwords and the current user.",
  "Break policies": "Break rules: how many, how long, and what relaxes during a break.",
  Compliance: "Dashboard metrics: who is connected, working, on break or needs attention.",
  Departments: "Organisation structure.",
  Devices: "Phones linked to employees — operational signals only (§12).",
  Employees: "Employee records, lifecycle, assignments and live state.",
  Imports: "CSV shift import wizard.",
  Integrations: "Workforce management integrations (coming soon).",
  Invites: "Employee invites and join instructions.",
  "Join code": "Company join code used by the iOS app.",
  Locations: "Organisation structure.",
  Marketing: "Public marketing-site endpoints (no authentication).",
  Members: "Managers of the organisation and their invites.",
  Mobile: "iOS app API (/api/mobile/v1). Strict request schemas: unknown fields are rejected.",
  Notifications: "In-app notifications for the signed-in manager.",
  Organisations: "The organisation, its defaults and onboarding.",
  Overrides: "Temporary manager overrides of Work Mode.",
  Policies: "Work Policies: what is restricted during shifts, versioned and assignable.",
  Realtime: "Server-Sent Events for dashboard cache invalidation.",
  Settings: "Organisation settings, notification preferences and billing information.",
  Shifts: "Schedules. Instants are UTC; wall-clock times are interpreted in the shift timezone.",
  System: "Operational endpoints for load balancers and uptime checks.",
  Teams: "Organisation structure.",
};

// ── JSON helpers ────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON.stringify with sorted keys — used only for equality checks. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key] as T;
  return out;
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Ids referenced through `#/$defs/<id>` anywhere inside `value`. */
function collectDefRefs(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) collectDefRefs(v, out);
  } else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === "$ref" && typeof v === "string" && v.startsWith(DEFS_REF_PREFIX)) {
        out.add(decodePointerSegment(v.slice(DEFS_REF_PREFIX.length)));
      } else {
        collectDefRefs(v, out);
      }
    }
  }
  return out;
}

// ── Zod → JSON Schema ───────────────────────────────────────────────────────

interface ZodInternals {
  _zod: { def: { type: string; catchall?: { _zod: { def: { type: string } } } } };
}

function isStrictObject(schema: unknown): boolean {
  const def = (schema as ZodInternals)._zod.def;
  return def.type === "object" && def.catchall?._zod.def.type === "never";
}

export interface Conversion {
  root: JsonSchema;
  defs: Record<string, JsonSchema>;
}

/**
 * Converts one schema. `$defs` are returned separately (refs still point at `#/$defs/<id>`); the
 * collector merges them across every conversion and rewrites refs once naming is settled.
 */
export function convertSchema(
  schema: z.ZodType,
  mode: IoMode,
  problems: string[] = [],
): Conversion {
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: mode,
    cycles: "ref",
    reused: "inline",
    unrepresentable: (ctx) => {
      problems.push(`${mode}: ${ctx.message} at ${ctx.path.join(".") || "<root>"}`);
      return "any";
    },
    override: (ctx) => {
      const js = ctx.jsonSchema as JsonSchema;
      if (js.minimum === Number.MIN_SAFE_INTEGER) delete js.minimum;
      if (js.maximum === Number.MAX_SAFE_INTEGER) delete js.maximum;
      // `format` is the contract; Zod's long implementation regexes for these formats only add noise.
      if (typeof js.format === "string" && FORMATS_WITHOUT_PATTERN.has(js.format))
        delete js.pattern;
      if (ctx.zodSchema === (isoDateTimeSchema as unknown)) {
        js.format = "date-time";
        js.description ??= "ISO-8601 instant with a timezone offset (Z or ±hh:mm)";
      }
      if (ctx.zodSchema === (queryBooleanSchema as unknown)) {
        js.type = "string";
        js.enum = ["true", "false", "1", "0", "yes", "no", "on", "off"];
        js.description ??= "Boolean (case-insensitive)";
      }
      if (ctx.zodSchema === (timezoneSchema as unknown)) {
        js.description ??= "IANA timezone identifier";
        js.examples ??= ["Europe/London"];
      }
      if (
        mode === "output" &&
        js.additionalProperties === false &&
        !isStrictObject(ctx.zodSchema)
      ) {
        delete js.additionalProperties;
      }
    },
  }) as JsonSchema;
  const { $schema: _dialect, $defs, ...root } = json;
  const defs = isPlainObject($defs) ? ($defs as Record<string, JsonSchema>) : {};
  for (const id of Object.keys(defs)) {
    if (id.startsWith("__schema")) {
      throw new Error(`Anonymous $def "${id}" produced (cycle?). Give the schema a .meta({ id }).`);
    }
  }
  return { root, defs };
}

/** Collects conversions in both modes, then names components and rewrites refs. */
export class SchemaCollector {
  private readonly defs: Record<IoMode, Map<string, JsonSchema>> = {
    input: new Map(),
    output: new Map(),
  };
  readonly problems: string[] = [];
  private names: { equal: Set<string> } | null = null;

  convert(schema: z.ZodType, mode: IoMode): JsonSchema {
    if (this.names !== null) throw new Error("SchemaCollector: convert() after finalize()");
    const { root, defs } = convertSchema(schema, mode, this.problems);
    for (const [id, def] of Object.entries(defs)) {
      const existing = this.defs[mode].get(id);
      if (existing !== undefined && canonical(existing) !== canonical(def)) {
        throw new Error(`Schema id "${id}" is used by two different schemas (${mode})`);
      }
      this.defs[mode].set(id, def);
    }
    return root;
  }

  /** Decides which input variants are identical to their output variant (transitively). */
  finalize(): void {
    const equal = new Set<string>();
    for (const [id, inputDef] of this.defs.input) {
      const outputDef = this.defs.output.get(id);
      if (outputDef !== undefined && canonical(outputDef) === canonical(inputDef)) equal.add(id);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of [...equal]) {
        const refs = collectDefRefs(this.defs.input.get(id));
        if ([...refs].some((ref) => !equal.has(ref))) {
          equal.delete(id);
          changed = true;
        }
      }
    }
    this.names = { equal };
  }

  componentName(id: string, mode: IoMode): string {
    if (this.names === null) throw new Error("SchemaCollector: finalize() first");
    if (mode === "output" || !this.defs.output.has(id) || this.names.equal.has(id)) return id;
    return `${id}Input`;
  }

  /** Deep copy of `value` with `#/$defs/<id>` refs pointing at components. */
  rewrite<T>(value: T, mode: IoMode): T {
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(walk);
      if (!isPlainObject(v)) return v;
      const out: JsonSchema = {};
      for (const [k, child] of Object.entries(v)) {
        if (k === "$ref" && typeof child === "string" && child.startsWith(DEFS_REF_PREFIX)) {
          out[k] =
            COMPONENT_REF_PREFIX +
            this.componentName(decodePointerSegment(child.slice(DEFS_REF_PREFIX.length)), mode);
        } else {
          out[k] = walk(child);
        }
      }
      return out;
    };
    return walk(value) as T;
  }

  /** Resolves a top-level `{ $ref }` to its definition (for parameter objects). */
  resolveRoot(root: JsonSchema, mode: IoMode): JsonSchema {
    const ref = root.$ref;
    if (typeof ref === "string" && ref.startsWith(DEFS_REF_PREFIX)) {
      const def = this.defs[mode].get(decodePointerSegment(ref.slice(DEFS_REF_PREFIX.length)));
      if (def !== undefined) return def;
    }
    return root;
  }

  components(): Record<string, JsonSchema> {
    const out: Record<string, JsonSchema> = {};
    for (const [id, def] of this.defs.output) out[id] = this.rewrite(def, "output");
    for (const [id, def] of this.defs.input) {
      const name = this.componentName(id, "input");
      if (out[name] !== undefined) {
        if (name !== id) throw new Error(`Component name collision: ${name}`);
        continue;
      }
      out[name] = this.rewrite(def, "input");
    }
    return sortedRecord(out);
  }
}

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Standard error codes a route can produce in addition to its declared `errors` — what `createHandler`
 * itself raises for the route's auth mode, validation, body handling, CSRF and rate limiting.
 */
export function standardErrorCodes(route: RouteDefinition): ApiErrorCode[] {
  const codes: ApiErrorCode[] = [];
  const req = route.request;
  if (req?.params || req?.query || req?.body) codes.push("VALIDATION_ERROR");
  if (req?.body) codes.push("PAYLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE");
  if (req?.params) codes.push("NOT_FOUND");
  switch (route.auth) {
    case "manager":
      // EMAIL_NOT_VERIFIED: only when the deployment sets REQUIRE_EMAIL_VERIFICATION=true.
      codes.push("UNAUTHENTICATED", "NO_ORGANISATION", "EMAIL_NOT_VERIFIED");
      if (route.permission) codes.push("FORBIDDEN");
      break;
    case "user":
      codes.push("UNAUTHENTICATED");
      break;
    case "mobile":
      codes.push("UNAUTHENTICATED", "DEVICE_INACTIVE");
      break;
    case "public":
      break;
    default: {
      const unreachable: never = route.auth;
      throw new Error(`Unhandled auth ${String(unreachable)}`);
    }
  }
  if (csrfRequired(route)) codes.push("CSRF_FAILED");
  if (route.rateLimit) codes.push("RATE_LIMITED");
  codes.push("INTERNAL_ERROR");
  return codes;
}

/** HTTP statuses the route's error codes map to (`ERROR_HTTP_STATUS`, unless the route overrides one). */
function errorCodesByStatus(route: RouteDefinition): Map<number, Set<ApiErrorCode>> {
  const byStatus = new Map<number, Set<ApiErrorCode>>();
  const entries = [
    ...standardErrorCodes(route).map((code) => ({ code, status: ERROR_HTTP_STATUS[code] })),
    ...(route.errors ?? []).map((e) =>
      typeof e === "string" ? { code: e, status: ERROR_HTTP_STATUS[e] } : e,
    ),
  ];
  for (const { code, status } of entries) {
    const set = byStatus.get(status) ?? new Set<ApiErrorCode>();
    set.add(code);
    byStatus.set(status, set);
  }
  return byStatus;
}

function errorResponses(route: RouteDefinition): Record<string, JsonSchema> {
  const byStatus = errorCodesByStatus(route);
  for (const status of Object.keys(route.responses).map(Number)) {
    if (byStatus.has(status)) {
      throw new Error(
        `${route.method} ${route.path}: declared response ${status} collides with the error envelope for ${[
          ...(byStatus.get(status) ?? []),
        ].join(", ")}`,
      );
    }
  }
  const out: Record<string, JsonSchema> = {};
  for (const status of [...byStatus.keys()].sort((a, b) => a - b)) {
    const codes = [...(byStatus.get(status) ?? [])].sort();
    out[String(status)] = {
      description: `Error: ${codes.join(", ")}`,
      "x-error-codes": codes,
      content: { "application/json": { schema: { $ref: `${COMPONENT_REF_PREFIX}ApiError` } } },
    };
  }
  return out;
}

// ── Document ────────────────────────────────────────────────────────────────

const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No content",
  503: "Service unavailable",
};

function isResponseContent(value: RouteResponse): value is RouteResponseContent {
  return value !== null && !(value instanceof z.ZodType);
}

function securityFor(route: RouteDefinition): Array<Record<string, string[]>> {
  const csrf = csrfRequired(route);
  switch (route.auth) {
    case "manager":
    case "user":
      return csrf ? [{ managerSession: [], csrfToken: [] }] : [{ managerSession: [] }];
    case "mobile":
      return [{ mobileBearer: [] }];
    case "public":
      return csrf ? [{ csrfToken: [] }] : [];
    default: {
      const unreachable: never = route.auth;
      throw new Error(`Unhandled auth ${String(unreachable)}`);
    }
  }
}

interface PendingOperation {
  route: RouteDefinition;
  build: () => JsonSchema;
}

export type OpenApiDocument = JsonSchema & {
  openapi: string;
  paths: Record<string, Record<string, JsonSchema>>;
  components: { schemas: Record<string, JsonSchema>; securitySchemes: Record<string, JsonSchema> };
};

export function buildOpenApiDocument(
  routes: readonly RouteDefinition[] = registry,
): OpenApiDocument {
  const collector = new SchemaCollector();
  collector.convert(apiErrorResponseSchema, "output");

  // Pass 1: convert every schema (collecting $defs); defer ref rewriting until names are settled.
  const pending: PendingOperation[] = routes.map((route) => {
    const req = route.request ?? {};
    const parameters: Array<{ location: "path" | "query"; root: JsonSchema }> = [];
    if (req.params)
      parameters.push({ location: "path", root: collector.convert(req.params, "input") });
    if (req.query)
      parameters.push({ location: "query", root: collector.convert(req.query, "input") });
    const bodyRoot = req.body ? collector.convert(req.body, "input") : null;
    const bodyRequired = req.body ? (req.bodyRequired ?? !req.body.safeParse({}).success) : false;
    const responseRoots = Object.entries(route.responses).map(([status, response]) => {
      if (response === null) return { status, response, root: null };
      const schema = isResponseContent(response) ? response.schema : response;
      return { status, response, root: schema ? collector.convert(schema, "output") : null };
    });

    const build = (): JsonSchema => {
      const operation: JsonSchema = {
        operationId: operationIdOf(route),
        summary: route.summary,
      };
      if (route.description) operation.description = route.description;
      operation.tags = [...route.tags];
      if (route.deprecated) operation.deprecated = true;

      const params: JsonSchema[] = [];
      for (const { location, root } of parameters) {
        const resolved = collector.resolveRoot(root, "input");
        const properties = isPlainObject(resolved.properties) ? resolved.properties : {};
        const required = new Set(
          Array.isArray(resolved.required) ? (resolved.required as string[]) : [],
        );
        for (const [name, propSchema] of Object.entries(properties)) {
          const schema = collector.rewrite(propSchema as JsonSchema, "input");
          const param: JsonSchema = {
            name,
            in: location,
            required: location === "path" || required.has(name),
          };
          if (typeof schema.description === "string") param.description = schema.description;
          param.schema = schema;
          if (location === "query" && schema.type === "array") {
            param.style = "form";
            param.explode = true;
          }
          params.push(param);
        }
      }
      if (params.length > 0) operation.parameters = params;

      if (bodyRoot !== null) {
        const contentType = req.bodyContentType ?? "application/json";
        const media: JsonSchema = { schema: collector.rewrite(bodyRoot, "input") };
        if (contentType === "multipart/form-data") {
          const properties = isPlainObject(bodyRoot.properties) ? bodyRoot.properties : {};
          const encoding: JsonSchema = {};
          for (const [name, prop] of Object.entries(properties)) {
            if (isPlainObject(prop) && prop.format === "binary") {
              const mediaTypes = [prop, ...(Array.isArray(prop.anyOf) ? prop.anyOf : [])]
                .map((p) => (isPlainObject(p) ? p.contentMediaType : undefined))
                .filter((t): t is string => typeof t === "string");
              encoding[name] = {
                contentType:
                  mediaTypes.length > 0 ? mediaTypes.join(", ") : "application/octet-stream",
              };
            }
          }
          if (Object.keys(encoding).length > 0) media.encoding = encoding;
        }
        operation.requestBody = { required: bodyRequired, content: { [contentType]: media } };
      }

      const responses: Record<string, JsonSchema> = {};
      for (const { status, response, root } of responseRoots) {
        const code = Number(status);
        if (response === null) {
          responses[status] = { description: STATUS_TEXT[code] ?? "No content" };
          continue;
        }
        if (isResponseContent(response)) {
          const description = response.description ?? STATUS_TEXT[code] ?? "Success";
          if (response.contentType === "text/event-stream") {
            const media: JsonSchema = {
              schema: { type: "string", description: "Server-Sent Events stream" },
            };
            if (root !== null) media["x-event-schema"] = collector.rewrite(root, "output");
            responses[status] = { description, content: { [response.contentType]: media } };
          } else {
            const schema = root !== null ? collector.rewrite(root, "output") : { type: "string" };
            responses[status] = { description, content: { [response.contentType]: { schema } } };
          }
          continue;
        }
        responses[status] = {
          description: STATUS_TEXT[code] ?? "Success",
          content: { "application/json": { schema: collector.rewrite(root, "output") } },
        };
      }
      Object.assign(responses, errorResponses(route));
      operation.responses = sortedRecord(responses);

      operation.security = securityFor(route);
      operation["x-auth"] = route.auth;
      if (route.permission) operation["x-permission"] = route.permission;
      if (route.rateLimit) operation["x-rate-limit"] = route.rateLimit;
      return operation;
    };
    return { route, build };
  });

  if (collector.problems.length > 0) {
    throw new Error(
      `Schemas with no JSON Schema representation:\n${collector.problems.join("\n")}`,
    );
  }
  collector.finalize();

  // Pass 2: build operations in deterministic order.
  const paths: Record<string, Record<string, JsonSchema>> = {};
  const sorted = [...pending].sort((a, b) => {
    const pa = toOpenApiPath(a.route.path);
    const pb = toOpenApiPath(b.route.path);
    if (pa !== pb) return pa < pb ? -1 : 1;
    return METHOD_ORDER.indexOf(a.route.method) - METHOD_ORDER.indexOf(b.route.method);
  });
  for (const { route, build } of sorted) {
    const path = toOpenApiPath(route.path);
    const item = paths[path] ?? {};
    item[route.method.toLowerCase()] = build();
    paths[path] = item;
  }

  const usedTags = [...new Set(routes.flatMap((r) => r.tags))].sort();
  for (const tag of usedTags) {
    if (TAG_DESCRIPTIONS[tag] === undefined)
      throw new Error(`Tag "${tag}" has no entry in TAG_DESCRIPTIONS`);
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "Work Mode API",
      version: API_DOC_VERSION,
      summary: "Manager dashboard API and iOS employee app API (/api/mobile/v1).",
      description:
        "Generated from the Zod schemas in packages/validation — do not edit by hand (run `pnpm openapi`). See docs/API.md for authentication, errors, pagination, idempotency, rate limits and versioning.",
    },
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    servers: [{ url: "http://localhost:3000", description: "Local development" }],
    tags: usedTags.map((name) => ({ name, description: TAG_DESCRIPTIONS[name] })),
    paths,
    components: {
      schemas: collector.components(),
      securitySchemes: {
        managerSession: {
          type: "apiKey",
          in: "cookie",
          name: "wm_session",
          description: "Opaque httpOnly session cookie set by POST /api/auth/login.",
        },
        csrfToken: {
          type: "apiKey",
          in: "header",
          name: "x-csrf-token",
          description:
            "Double-submit CSRF token: echo the value of the `wm_csrf` cookie on every mutating request.",
        },
        mobileBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "Short-lived access token from /api/mobile/v1/join/confirm or /auth/refresh.",
        },
      },
    },
  };
}

export function renderOpenApiJson(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function writeOpenApiDocument(outputPath: string = OPENAPI_OUTPUT_PATH): {
  path: string;
  paths: number;
  operations: number;
} {
  const document = buildOpenApiDocument();
  writeFileSync(outputPath, renderOpenApiJson(document));
  const operations = Object.values(document.paths).reduce(
    (n, item) => n + Object.keys(item).length,
    0,
  );
  return { path: outputPath, paths: Object.keys(document.paths).length, operations };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = writeOpenApiDocument();
  console.info(`Wrote ${result.path} (${result.paths} paths, ${result.operations} operations)`);
}
