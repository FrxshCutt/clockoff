import { stableId } from "./util";

/** Every seeded manager signs in with this password. */
export const DEMO_PASSWORD = "Password123!";

export type DemoRole = "OWNER" | "ADMIN" | "MANAGER";

export interface DemoManager {
  readonly email: string;
  readonly name: string;
  readonly role: DemoRole;
}

export const HARPENDEN = {
  key: "harpenden",
  name: "Harpenden Coffee Co.",
  slug: "harpenden-coffee-co",
  timezone: "Europe/London",
  joinCode: "BREW-4821",
  /** Historical code, revoked when the current one was issued. */
  revokedJoinCode: "LATTE-3407",
  managers: {
    owner: { email: "owner@harpendencoffee.test", name: "Olivia Bennett", role: "OWNER" },
    admin: { email: "manager@harpendencoffee.test", name: "Priya Shah", role: "ADMIN" },
    manager: { email: "supervisor@harpendencoffee.test", name: "Marcus Lee", role: "MANAGER" },
  },
} as const satisfies { managers: Record<string, DemoManager> } & Record<string, unknown>;

export const OTHER_CO = {
  key: "other-co",
  name: "Other Co",
  slug: "other-co",
  timezone: "Europe/London",
  joinCode: "OTHR-1234",
  managers: {
    owner: { email: "owner@otherco.test", name: "Sam Taylor", role: "OWNER" },
  },
} as const satisfies { managers: Record<string, DemoManager> } & Record<string, unknown>;

export const DEMO_ORGANISATIONS = [HARPENDEN, OTHER_CO] as const;

export const DEMO_MANAGERS: readonly DemoManager[] = [
  ...Object.values(HARPENDEN.managers),
  ...Object.values(OTHER_CO.managers),
];

export function organisationIdFor(orgKey: string): string {
  return stableId(`${orgKey}:organisation`);
}

export function userIdFor(email: string): string {
  return stableId(`user:${email.toLowerCase()}`);
}
