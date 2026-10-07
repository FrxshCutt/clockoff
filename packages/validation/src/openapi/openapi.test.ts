import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as sharedEnums from "@clockoff/shared/enums";
import { API_ERROR_CODES } from "@clockoff/shared/errors";
import { PERMISSIONS } from "@clockoff/shared/permissions";
import {
  buildOpenApiDocument,
  convertSchema,
  OPENAPI_OUTPUT_PATH,
  renderOpenApiJson,
  SchemaCollector,
  standardErrorCodes,
  type JsonSchema,
} from "./generate";
import {
  assertValidRoute,
  csrfRequired,
  deriveOperationId,
  isMutatingMethod,
  operationIdOf,
  pathParamNames,
  registry,
  routeKey,
  toOpenApiPath,
  type RouteDefinition,
} from "./registry";
import "./routes";

const document = buildOpenApiDocument();
const schemas = document.components.schemas;

function operationFor(route: RouteDefinition): JsonSchema {
  const operation = document.paths[toOpenApiPath(route.path)]?.[route.method.toLowerCase()];
  if (!operation) throw new Error(`No operation for ${routeKey(route)}`);
  return operation;
}

function isObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectRefs(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => collectRefs(v, out));
  else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === "$ref" && typeof v === "string") out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}

function resolve(schema: JsonSchema): JsonSchema {
  const ref = schema.$ref;
  if (typeof ref === "string") {
    const target = schemas[ref.replace("#/components/schemas/", "")];
    if (!target) throw new Error(`Unresolved ${ref}`);
    return resolve(target);
  }
  return schema;
}

/**
 * Every endpoint the spec (§5) requires, as `METHOD /path`, plus the manager auth and health routes that
 * apps/web implements. Path params use the names of the Next.js route folders.
 */
const REQUIRED_ENDPOINTS = [
  "GET /api/health",
  "POST /api/auth/register",
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "GET /api/auth/me",
  "POST /api/auth/forgot-password",
  "POST /api/auth/reset-password",
  "POST /api/auth/verify-email",
  "POST /api/auth/resend-verification",
  "POST /api/auth/change-password",
  "POST /api/auth/switch-organisation",
  "GET /api/organisations",
  "POST /api/organisations",
  "GET /api/organisations/current",
  "PATCH /api/organisations/current",
  "GET /api/organisations/current/onboarding",
  "POST /api/organisations/current/onboarding/dismiss",
  "GET /api/organisations/current/members",
  "POST /api/organisations/current/members",
  "PATCH /api/organisations/current/members/:membershipId",
  "DELETE /api/organisations/current/members/:membershipId",
  "POST /api/organisations/current/members/invite",
  "POST /api/organisations/current/members/accept",
  "GET /api/invites/manager/:token",
  "GET /api/organisations/current/join-code",
  "POST /api/organisations/current/join-code/regenerate",
  "POST /api/organisations/current/join-code/revoke",
  "GET /api/employees",
  "POST /api/employees",
  "GET /api/employees/:id",
  "PATCH /api/employees/:id",
  "POST /api/employees/:id/deactivate",
  "POST /api/employees/:id/reactivate",
  "POST /api/employees/:id/archive",
  "POST /api/employees/:id/assign-policy",
  "POST /api/employees/:id/assign-break-policy",
  "POST /api/employees/:id/assign-location",
  "POST /api/employees/:id/assign-team",
  "GET /api/employees/:id/state",
  "GET /api/employees/:id/shifts",
  "GET /api/employees/:id/activity",
  "POST /api/employees/bulk",
  "POST /api/employees/:id/invites",
  "POST /api/invites/:id/resend",
  "POST /api/invites/:id/revoke",
  "GET /api/invites/:id/instructions",
  "GET /api/devices",
  "GET /api/devices/:id",
  "POST /api/devices/:id/deactivate",
  "GET /api/policies",
  "POST /api/policies",
  "GET /api/policies/:id",
  "PATCH /api/policies/:id",
  "DELETE /api/policies/:id",
  "POST /api/policies/:id/publish",
  "POST /api/policies/:id/duplicate",
  "POST /api/policies/:id/archive",
  "GET /api/policies/:id/versions",
  "POST /api/policies/:id/assignments",
  "DELETE /api/policy-assignments/:id",
  "POST /api/organisations/current/default-policy",
  "GET /api/break-policies",
  "POST /api/break-policies",
  "GET /api/break-policies/:id",
  "PATCH /api/break-policies/:id",
  "DELETE /api/break-policies/:id",
  "POST /api/break-policies/:id/assignments",
  "DELETE /api/break-policy-assignments/:id",
  "POST /api/organisations/current/default-break-policy",
  "GET /api/shifts",
  "POST /api/shifts",
  "PATCH /api/shifts/:id",
  "DELETE /api/shifts/:id",
  "POST /api/shifts/:id/duplicate",
  "POST /api/shifts/:id/cancel",
  "POST /api/shifts/bulk",
  "POST /api/imports",
  "GET /api/imports/:id",
  "POST /api/imports/:id/mapping",
  "POST /api/imports/:id/validate",
  "GET /api/imports/:id/rows",
  "PATCH /api/imports/:id/rows/:rowId",
  "POST /api/imports/:id/commit",
  "GET /api/imports/:id/errors.csv",
  "GET /api/integrations",
  "POST /api/integrations/:provider/connect",
  "POST /api/integrations/:provider/disconnect",
  "POST /api/integrations/:provider/sync",
  "POST /api/integrations/:provider/notify-me",
  "GET /api/compliance/summary",
  "GET /api/compliance/employees",
  "GET /api/activity",
  "GET /api/locations",
  "POST /api/locations",
  "PATCH /api/locations/:id",
  "DELETE /api/locations/:id",
  "GET /api/departments",
  "POST /api/departments",
  "PATCH /api/departments/:id",
  "DELETE /api/departments/:id",
  "GET /api/teams",
  "POST /api/teams",
  "PATCH /api/teams/:id",
  "DELETE /api/teams/:id",
  "POST /api/teams/:id/members",
  "GET /api/settings",
  "PATCH /api/settings",
  "GET /api/settings/billing",
  "GET /api/overrides",
  "POST /api/overrides",
  "POST /api/overrides/:id/revoke",
  "GET /api/audit-logs",
  "GET /api/notifications",
  "POST /api/notifications/:id/read",
  "POST /api/notifications/read-all",
  "GET /api/realtime/stream",
  "POST /api/mobile/v1/join/lookup",
  "POST /api/mobile/v1/join/confirm",
  "POST /api/mobile/v1/auth/refresh",
  "POST /api/mobile/v1/auth/logout",
  "POST /api/mobile/v1/leave-workplace",
  "GET /api/mobile/v1/me",
  "GET /api/mobile/v1/schedule",
  "GET /api/mobile/v1/sync",
  "POST /api/mobile/v1/device/state",
  "POST /api/mobile/v1/events",
  "POST /api/mobile/v1/breaks/start",
  "POST /api/mobile/v1/breaks/:id/end",
  "POST /api/mobile/v1/device/push-token",
];

describe("OpenAPI document", () => {
  it("is valid JSON and declares OpenAPI 3.1", () => {
    const text = renderOpenApiJson(document);
    const parsed = JSON.parse(text) as JsonSchema;
    expect(parsed.openapi).toBe("3.1.0");
    expect(parsed.jsonSchemaDialect).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("contains every registered route, and every path starts with /api", () => {
    expect(registry.length).toBeGreaterThan(100);
    for (const route of registry) {
      const item = document.paths[toOpenApiPath(route.path)];
      expect(item, `${route.method} ${route.path}`).toBeDefined();
      expect(item?.[route.method.toLowerCase()], `${route.method} ${route.path}`).toBeDefined();
    }
    const operations = Object.values(document.paths).reduce(
      (n, item) => n + Object.keys(item).length,
      0,
    );
    expect(operations).toBe(registry.length);
    for (const path of Object.keys(document.paths)) expect(path.startsWith("/api/")).toBe(true);
  });

  it("covers every endpoint required by the spec", () => {
    const registered = new Set(registry.map((r) => `${r.method} ${r.path}`));
    const missing = REQUIRED_ENDPOINTS.filter((e) => !registered.has(e));
    expect(missing).toEqual([]);
  });

  it("has unique operationIds", () => {
    const ids = registry.map(operationIdOf);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves every $ref to a component", () => {
    const refs = collectRefs(document);
    expect(refs.length).toBeGreaterThan(100);
    for (const ref of refs) {
      expect(ref.startsWith("#/components/schemas/"), ref).toBe(true);
      expect(schemas[ref.replace("#/components/schemas/", "")], ref).toBeDefined();
    }
  });

  it("has no leftover $defs, Zod ids or Number.MAX_SAFE_INTEGER bounds", () => {
    const text = JSON.stringify(document);
    expect(text).not.toContain("$defs");
    expect(text).not.toContain(String(Number.MAX_SAFE_INTEGER));
    expect(text).not.toContain('"__schema');
  });

  it("is deterministic", () => {
    expect(renderOpenApiJson(buildOpenApiDocument())).toBe(renderOpenApiJson(document));
    expect(Object.keys(document.paths)).toEqual([...Object.keys(document.paths)].sort());
    expect(Object.keys(schemas)).toEqual([...Object.keys(schemas)].sort());
  });

  it("matches the committed docs/openapi.json (run `pnpm openapi` after changing a schema)", () => {
    const committed = JSON.parse(readFileSync(OPENAPI_OUTPUT_PATH, "utf8")) as unknown;
    expect(committed).toEqual(JSON.parse(renderOpenApiJson(document)));
  });

  it("declares the security schemes and applies them per auth mode", () => {
    expect(Object.keys(document.components.securitySchemes).sort()).toEqual([
      "csrfToken",
      "managerSession",
      "mobileBearer",
    ]);
    expect(document.paths["/api/employees"]?.get?.security).toEqual([{ managerSession: [] }]);
    expect(document.paths["/api/employees"]?.post?.security).toEqual([
      { managerSession: [], csrfToken: [] },
    ]);
    expect(document.paths["/api/mobile/v1/sync"]?.get?.security).toEqual([{ mobileBearer: [] }]);
    expect(document.paths["/api/mobile/v1/join/lookup"]?.post?.security).toEqual([]);
  });

  it("documents the error envelope on every operation", () => {
    expect(schemas.ApiError).toBeDefined();
    for (const route of registry) {
      const operation = operationFor(route);
      const responses = operation.responses as Record<string, JsonSchema>;
      expect(responses["500"]?.["x-error-codes"]).toContain("INTERNAL_ERROR");
      for (const [status, response] of Object.entries(responses)) {
        // Statuses a route declares itself (GET /api/health 503) carry their own body.
        if (Number(status) < 400 || status in route.responses) continue;
        expect(collectRefs(response), `${routeKey(route)} ${status}`).toEqual([
          "#/components/schemas/ApiError",
        ]);
        expect((response["x-error-codes"] as string[]).length).toBeGreaterThan(0);
      }
    }
    const createShift = document.paths["/api/shifts"]?.post?.responses as Record<
      string,
      JsonSchema
    >;
    expect(createShift["409"]?.["x-error-codes"]).toEqual(
      expect.arrayContaining(["SHIFT_OVERLAP", "EMPLOYEE_INACTIVE"]),
    );
    expect(createShift["403"]?.["x-error-codes"]).toEqual([
      "CSRF_FAILED",
      "EMAIL_NOT_VERIFIED",
      "FORBIDDEN",
      "NO_ORGANISATION",
    ]);
    // A per-route status override moves the code to that status.
    const preview = document.paths["/api/invites/manager/{token}"]?.get?.responses as Record<
      string,
      JsonSchema
    >;
    expect(preview["404"]?.["x-error-codes"]).toEqual(["INVITE_INVALID", "NOT_FOUND"]);
    expect(preview["400"]?.["x-error-codes"]).toEqual(["VALIDATION_ERROR"]);
  });

  it("makes every JSON request body strict (unknown keys rejected)", () => {
    for (const item of Object.values(document.paths)) {
      for (const operation of Object.values(item)) {
        const body = operation.requestBody as JsonSchema | undefined;
        if (!body) continue;
        const content = body.content as Record<string, { schema: JsonSchema }>;
        for (const media of Object.values(content)) {
          const root = resolve(media.schema);
          const variants = (root.oneOf ?? root.anyOf ?? [root]) as JsonSchema[];
          for (const variant of variants) {
            expect(resolve(variant).additionalProperties, `${String(operation.operationId)}`).toBe(
              false,
            );
          }
        }
      }
    }
  });

  it("keeps response objects open for additive evolution", () => {
    expect(schemas.Employee?.additionalProperties).toBeUndefined();
    expect(schemas.MobileSyncResponse?.additionalProperties).toBeUndefined();
    // Strict schemas shared with requests stay strict in both directions.
    expect(schemas.RestrictionConfig?.additionalProperties).toBe(false);
  });

  it("documents query-list parameters as exploded arrays and booleans as strings", () => {
    const params = document.paths["/api/employees"]?.get?.parameters as JsonSchema[];
    const inviteStatus = params.find((p) => p.name === "inviteStatus");
    expect(inviteStatus).toMatchObject({
      in: "query",
      required: false,
      style: "form",
      explode: true,
    });
    const policies = document.paths["/api/policies"]?.get?.parameters as JsonSchema[];
    expect(policies.find((p) => p.name === "includeArchived")?.schema).toMatchObject({
      type: "string",
    });
    const path = document.paths["/api/employees/{id}"]?.get?.parameters as JsonSchema[];
    expect(path).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
    ]);
  });

  it("documents multipart upload, CSV download and the SSE stream", () => {
    const upload = document.paths["/api/imports"]?.post?.requestBody as JsonSchema;
    const multipart = (upload.content as Record<string, JsonSchema>)["multipart/form-data"];
    expect((multipart?.schema as JsonSchema).required).toEqual(["file"]);
    const csv = (
      document.paths["/api/imports/{id}/errors.csv"]?.get?.responses as Record<string, JsonSchema>
    )["200"];
    expect(Object.keys(csv?.content as JsonSchema)).toEqual(["text/csv"]);
    const sse = (
      document.paths["/api/realtime/stream"]?.get?.responses as Record<string, JsonSchema>
    )["200"];
    const media = (sse?.content as Record<string, JsonSchema>)["text/event-stream"];
    expect(media?.["x-event-schema"]).toEqual({ $ref: "#/components/schemas/SseEvent" });
    expect(schemas.SseEvent?.required).toEqual(["type", "organisationId", "payload", "at"]);
  });

  it("encodes the override duration cap in schema metadata", () => {
    const body = document.paths["/api/overrides"]?.post?.requestBody as JsonSchema;
    const schema = (body.content as Record<string, { schema: JsonSchema }>)["application/json"]
      ?.schema;
    const duration = (schema?.properties as Record<string, JsonSchema>).durationMinutes;
    expect(duration).toMatchObject({ "x-max-duration-minutes": 1440, maximum: 10080 });
  });

  it("marks bodies that accept {} as optional", () => {
    expect(
      (document.paths["/api/employees/{id}/archive"]?.post?.requestBody as JsonSchema).required,
    ).toBe(false);
    expect((document.paths["/api/employees"]?.post?.requestBody as JsonSchema).required).toBe(true);
  });
});

describe("OpenAPI document — completeness, strictness and naming", () => {
  const HTTP_METHOD_KEYS = new Set(["get", "post", "put", "patch", "delete"]);
  const JSON_SCHEMA_TYPES = new Set([
    "string",
    "number",
    "integer",
    "boolean",
    "object",
    "array",
    "null",
  ]);
  const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
  const PASCAL_CASE = /^[A-Z][a-zA-Z0-9]*$/;

  /** Visits every schema-like object with a dotted path. */
  function visit(value: unknown, path: string, fn: (node: JsonSchema, path: string) => void): void {
    if (Array.isArray(value)) value.forEach((v, i) => visit(v, `${path}[${i}]`, fn));
    else if (isObject(value)) {
      fn(value, path);
      for (const [k, v] of Object.entries(value)) visit(v, `${path}.${k}`, fn);
    }
  }

  function operations(): Array<{ path: string; method: string; operation: JsonSchema }> {
    return Object.entries(document.paths).flatMap(([path, item]) =>
      Object.entries(item).map(([method, operation]) => ({ path, method, operation })),
    );
  }

  it("declares a body for every POST / PUT / PATCH and a schema for every 2xx response with content", () => {
    for (const route of registry) {
      if (route.method === "POST" || route.method === "PUT" || route.method === "PATCH") {
        expect(route.request?.body, `${routeKey(route)} has no body schema`).toBeDefined();
      }
      for (const [status, response] of Object.entries(route.responses)) {
        const code = Number(status);
        if (code < 200 || code >= 300) continue;
        if (code === 204) {
          expect(response, `${routeKey(route)} 204 must have no body`).toBeNull();
          continue;
        }
        expect(response, `${routeKey(route)} ${status} has no schema`).not.toBeNull();
        if (response !== null && !(response instanceof z.ZodType)) {
          expect(response.schema, `${routeKey(route)} ${status} has no schema`).toBeDefined();
        }
      }
    }
    expect(
      registry
        .filter((r) => r.method === "DELETE")
        .every((r) => 204 in r.responses || 200 in r.responses),
    ).toBe(true);
  });

  it("makes every object inside a request body or path params strict (records must constrain keys)", () => {
    for (const route of registry) {
      for (const part of ["body", "params"] as const) {
        const schema = route.request?.[part];
        if (!schema) continue;
        const { root, defs } = convertSchema(schema, "input");
        visit({ root, defs }, `${routeKey(route)} ${part}`, (node, path) => {
          if (node.type !== "object") return;
          if (isObject(node.properties)) {
            expect(node.additionalProperties, `${path} is not strict`).toBe(false);
          } else {
            // A record (`{ "<csv header>": field }`): keys and values must both be constrained.
            expect(node.propertyNames, `${path} is an unconstrained object`).toBeDefined();
            expect(isObject(node.additionalProperties), `${path} has unconstrained values`).toBe(
              true,
            );
          }
        });
      }
    }
  });

  it("uses camelCase for every property, parameter and operationId, PascalCase for components", () => {
    const offenders: string[] = [];
    visit(document, "", (node, path) => {
      if (isObject(node.properties)) {
        for (const key of Object.keys(node.properties)) {
          if (!CAMEL_CASE.test(key)) offenders.push(`${path}.properties.${key}`);
        }
      }
    });
    expect(offenders).toEqual([]);
    for (const { path, method, operation } of operations()) {
      expect(CAMEL_CASE.test(String(operation.operationId)), `${method} ${path}`).toBe(true);
      for (const param of (operation.parameters as JsonSchema[] | undefined) ?? []) {
        expect(CAMEL_CASE.test(String(param.name)), `${method} ${path} ${String(param.name)}`).toBe(
          true,
        );
      }
    }
    for (const name of Object.keys(schemas)) expect(PASCAL_CASE.test(name), name).toBe(true);
  });

  it("takes every domain enum from @clockoff/shared and references it by its named component", () => {
    const shared: Record<string, readonly string[]> = { API_ERROR_CODES, PERMISSIONS };
    for (const [name, value] of Object.entries(sharedEnums)) {
      if (Array.isArray(value)) shared[name] = value as readonly string[];
    }
    const keyOf = (values: readonly unknown[]) => JSON.stringify([...values].map(String).sort());
    const byValues = new Map(Object.entries(shared).map(([name, values]) => [keyOf(values), name]));
    const componentFor = new Map<string, string>();
    for (const [name, component] of Object.entries(schemas)) {
      if (!Array.isArray(component.enum)) continue;
      const sharedName = byValues.get(keyOf(component.enum));
      if (sharedName !== undefined) {
        // Same order as the shared const array (the Swift enum and the UI rely on it).
        expect(component.enum, name).toEqual([...(shared[sharedName] ?? [])]);
        componentFor.set(sharedName, name);
      }
    }
    // Every shared enum the API exposes has exactly one named component...
    for (const name of [
      "WORK_MODE_STATES",
      "RESTRICTION_CATEGORIES",
      "ROLES",
      "API_ERROR_CODES",
      "PERMISSIONS",
    ]) {
      expect(componentFor.has(name), name).toBe(true);
    }
    // ...and nothing inlines a copy of one instead of referencing it.
    const inlined: string[] = [];
    for (const [name, component] of Object.entries(schemas)) {
      visit(component, name, (node, path) => {
        if (path === name || !Array.isArray(node.enum)) return;
        const sharedName = byValues.get(keyOf(node.enum));
        if (sharedName !== undefined) inlined.push(`${path} inlines ${sharedName}`);
      });
    }
    visit(document.paths, "paths", (node, path) => {
      if (!Array.isArray(node.enum)) return;
      const sharedName = byValues.get(keyOf(node.enum));
      if (sharedName !== undefined) inlined.push(`${path} inlines ${sharedName}`);
    });
    expect(inlined).toEqual([]);
    expect(schemas.ApiError?.properties).toMatchObject({
      error: { properties: { code: { $ref: "#/components/schemas/ApiErrorCode" } } },
    });
  });

  it("is a structurally valid OpenAPI 3.1 document", () => {
    expect(document.info).toMatchObject({ title: expect.any(String), version: expect.any(String) });
    const declaredTags = new Set((document.tags as Array<{ name: string }>).map((t) => t.name));
    const schemeNames = new Set(Object.keys(document.components.securitySchemes));
    for (const { path, method, operation } of operations()) {
      const where = `${method.toUpperCase()} ${path}`;
      expect(HTTP_METHOD_KEYS.has(method), where).toBe(true);
      // Path template params ↔ `in: path` parameters, all required; no duplicate (name, in).
      const parameters = (operation.parameters as JsonSchema[] | undefined) ?? [];
      const templateParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const pathParams = parameters.filter((p) => p.in === "path");
      expect(
        pathParams.map((p) => p.name),
        where,
      ).toEqual(templateParams);
      for (const p of pathParams) expect(p.required, where).toBe(true);
      const seen = new Set(parameters.map((p) => `${String(p.in)}:${String(p.name)}`));
      expect(seen.size, where).toBe(parameters.length);
      for (const p of parameters) {
        expect(["path", "query"]).toContain(p.in);
        expect(isObject(p.schema), `${where} ${String(p.name)}`).toBe(true);
      }
      for (const tag of operation.tags as string[]) expect(declaredTags.has(tag), where).toBe(true);
      for (const requirement of operation.security as Array<Record<string, unknown>>) {
        for (const scheme of Object.keys(requirement))
          expect(schemeNames.has(scheme), where).toBe(true);
      }
      const responses = operation.responses as Record<string, JsonSchema>;
      expect(Object.keys(responses).length, where).toBeGreaterThan(0);
      for (const [status, response] of Object.entries(responses)) {
        expect(/^[1-5]\d\d$/.test(status), `${where} ${status}`).toBe(true);
        expect(typeof response.description, `${where} ${status}`).toBe("string");
        for (const mediaType of Object.keys((response.content as JsonSchema | undefined) ?? {})) {
          expect(mediaType, where).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/);
        }
      }
      const body = operation.requestBody as JsonSchema | undefined;
      if (body) {
        expect(typeof body.required, where).toBe("boolean");
        expect(Object.keys(body.content as JsonSchema).length, where).toBe(1);
      }
    }
    // JSON Schema sanity on every schema object: valid `type`s, `required` ⊆ `properties`.
    visit({ components: document.components.schemas, paths: document.paths }, "", (node, path) => {
      // (In a `properties` map, a field literally named `type` is a schema object, not a string.)
      const types: unknown[] = Array.isArray(node.type) ? node.type : [node.type];
      for (const t of types) {
        if (typeof t === "string")
          expect(JSON_SCHEMA_TYPES.has(t), `${path}: type ${t}`).toBe(true);
      }
      if (Array.isArray(node.required) && isObject(node.properties)) {
        for (const key of node.required as string[]) {
          expect(Object.hasOwn(node.properties, key), `${path}: required ${key}`).toBe(true);
        }
      }
    });
  });

  it("references every component (no dead schemas)", () => {
    const text = JSON.stringify({ paths: document.paths, components: document.components });
    const unreferenced = Object.keys(schemas).filter(
      (name) => !text.includes(`"#/components/schemas/${name}"`),
    );
    expect(unreferenced).toEqual([]);
  });
});

describe("authentication modes", () => {
  it("applies the CSRF rule exactly like createHandler", () => {
    expect(isMutatingMethod("GET")).toBe(false);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      expect(isMutatingMethod(method)).toBe(true);
      expect(csrfRequired({ auth: "manager", method })).toBe(true);
      expect(csrfRequired({ auth: "user", method })).toBe(true);
      expect(csrfRequired({ auth: "mobile", method })).toBe(false);
      expect(csrfRequired({ auth: "public", method })).toBe(false);
    }
    expect(csrfRequired({ auth: "manager", method: "GET" })).toBe(false);
    expect(csrfRequired({ auth: "public", method: "POST", csrf: true })).toBe(true);
    for (const route of registry) {
      const security = operationFor(route).security as Array<Record<string, unknown>>;
      const schemes = security.flatMap((s) => Object.keys(s));
      expect(schemes.includes("csrfToken"), routeKey(route)).toBe(csrfRequired(route));
      expect(schemes.includes("managerSession"), routeKey(route)).toBe(
        route.auth === "manager" || route.auth === "user",
      );
      expect(schemes.includes("mobileBearer"), routeKey(route)).toBe(route.auth === "mobile");
      expect(operationFor(route)["x-auth"]).toBe(route.auth);
    }
  });

  it("documents the signed-in-without-organisation (user) routes and the CSRF-protected public logout", () => {
    expect(document.paths["/api/auth/me"]?.get?.security).toEqual([{ managerSession: [] }]);
    expect(document.paths["/api/organisations"]?.post?.security).toEqual([
      { managerSession: [], csrfToken: [] },
    ]);
    expect(document.paths["/api/auth/logout"]?.post?.security).toEqual([{ csrfToken: [] }]);
    expect(document.paths["/api/auth/login"]?.post?.security).toEqual([]);
    const me = registry.find((r) => routeKey(r) === "GET /api/auth/me");
    expect(me && standardErrorCodes(me)).toEqual(["UNAUTHENTICATED", "INTERNAL_ERROR"]);
    const createOrg = document.paths["/api/organisations"]?.post?.responses as Record<
      string,
      JsonSchema
    >;
    expect(createOrg["403"]?.["x-error-codes"]).toEqual(["CSRF_FAILED", "EMAIL_NOT_VERIFIED"]);
  });
});

describe("route registry", () => {
  const base: RouteDefinition = {
    method: "GET",
    path: "/api/things/:id",
    summary: "Get a thing",
    tags: ["Employees"],
    auth: "manager",
    request: { params: z.object({ id: z.uuid() }) },
    responses: { 200: z.object({ ok: z.boolean() }) },
  };

  it("accepts a consistent route", () => {
    expect(() => assertValidRoute(base)).not.toThrow();
  });

  it("rejects paths outside /api, param mismatches and bad combinations", () => {
    expect(() => assertValidRoute({ ...base, path: "/things/:id" })).toThrow(
      /must start with \/api/,
    );
    expect(() => assertValidRoute({ ...base, request: {} })).toThrow(/no params schema/);
    expect(() =>
      assertValidRoute({ ...base, request: { params: z.object({ thingId: z.uuid() }) } }),
    ).toThrow(/do not match/);
    expect(() =>
      assertValidRoute({ ...base, request: { ...base.request, body: z.object({}) } }),
    ).toThrow(/cannot declare a body/);
    expect(() => assertValidRoute({ ...base, responses: { 404: null } })).toThrow(/2xx/);
    expect(() => assertValidRoute({ ...base, auth: "mobile" })).toThrow(/mobile auth/);
    expect(() =>
      assertValidRoute({ ...base, auth: "public", permission: "employees:read" }),
    ).toThrow(/permission/);
  });

  it("derives OpenAPI paths and operation ids", () => {
    expect(toOpenApiPath("/api/imports/:id/rows/:rowId")).toBe("/api/imports/{id}/rows/{rowId}");
    expect(pathParamNames("/api/imports/:id/rows/:rowId")).toEqual(["id", "rowId"]);
    expect(deriveOperationId("PATCH", "/api/imports/:id/rows/:rowId")).toBe(
      "patchImportsByIdRowsByRowId",
    );
    expect(deriveOperationId("POST", "/api/mobile/v1/device/push-token")).toBe(
      "postMobileV1DevicePushToken",
    );
    expect(deriveOperationId("GET", "/api/imports/:id/errors.csv")).toBe("getImportsByIdErrorsCsv");
  });

  it("adds the standard error codes for each auth mode", () => {
    expect(standardErrorCodes(base)).toEqual(
      expect.arrayContaining([
        "VALIDATION_ERROR",
        "NOT_FOUND",
        "UNAUTHENTICATED",
        "NO_ORGANISATION",
        "INTERNAL_ERROR",
      ]),
    );
    expect(standardErrorCodes({ ...base, method: "POST", permission: "employees:write" })).toEqual(
      expect.arrayContaining(["CSRF_FAILED", "FORBIDDEN"]),
    );
    expect(standardErrorCodes({ ...base, path: "/api/mobile/v1/x/:id", auth: "mobile" })).toEqual(
      expect.arrayContaining(["DEVICE_INACTIVE", "UNAUTHENTICATED"]),
    );
  });
});

describe("SchemaCollector", () => {
  it("publishes an <id>Input variant only when input and output differ", () => {
    const Same = z.object({ a: z.string() }).meta({ id: "TestSame" });
    const WithDefault = z.object({ n: z.int().default(1) }).meta({ id: "TestWithDefault" });
    const Parent = z.object({ child: WithDefault, same: Same }).meta({ id: "TestParent" });
    const collector = new SchemaCollector();
    const inputRoot = collector.convert(Parent, "input");
    collector.convert(Parent, "output");
    collector.finalize();
    const components = collector.components();
    expect(Object.keys(components).sort()).toEqual([
      "TestParent",
      "TestParentInput",
      "TestSame",
      "TestWithDefault",
      "TestWithDefaultInput",
    ]);
    expect(collector.rewrite(inputRoot, "input")).toEqual({
      $ref: "#/components/schemas/TestParentInput",
    });
    expect(components.TestWithDefault?.required).toEqual(["n"]);
    expect(components.TestWithDefaultInput?.required).toBeUndefined();
  });

  it("rejects two different schemas sharing an id", () => {
    const collector = new SchemaCollector();
    collector.convert(z.object({ a: z.string() }).meta({ id: "TestClash" }), "output");
    expect(() =>
      collector.convert(z.object({ b: z.string() }).meta({ id: "TestClash" }), "output"),
    ).toThrow(/two different/);
  });

  it("reports schemas with no JSON representation", () => {
    const problems: string[] = [];
    convertSchema(z.object({ when: z.date() }), "output", problems);
    expect(problems.length).toBe(1);
  });
});
