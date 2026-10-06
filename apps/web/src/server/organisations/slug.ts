import { randomBytes } from "node:crypto";

/**
 * Organisation slugs: lowercase ASCII, digits and single hyphens, 1–48 chars. Uniqueness is enforced
 * by the database (`organisations.slug` UNIQUE); {@link slugCandidates} yields the base slug followed
 * by numbered and finally random suffixes for the creator to try in order.
 */
const MAX_SLUG_LENGTH = 48;

export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || "organisation";
}

function withSuffix(base: string, suffix: string): string {
  const room = MAX_SLUG_LENGTH - suffix.length - 1;
  return `${base.slice(0, room).replace(/-+$/g, "")}-${suffix}`;
}

function defaultRandomSuffix(): string {
  return randomBytes(6)
    .toString("base64url")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "x")
    .slice(0, 6);
}

/** `acme`, `acme-2` … `acme-<numbered>`, then random 6-char suffixes. */
export function slugCandidates(
  name: string,
  options: { numbered?: number; random?: number; randomSuffix?: () => string } = {},
): string[] {
  const base = slugify(name);
  const numbered = options.numbered ?? 5;
  const random = options.random ?? 3;
  const randomSuffix = options.randomSuffix ?? defaultRandomSuffix;
  const out = [base];
  for (let n = 2; n <= numbered; n++) out.push(withSuffix(base, String(n)));
  for (let i = 0; i < random; i++) out.push(withSuffix(base, randomSuffix()));
  return out;
}
