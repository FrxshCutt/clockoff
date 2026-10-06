import { ACTIVATION_MODES, RESTRICTION_CATEGORIES } from "../enums";
import type { ActivationMode, RestrictionCategory } from "../enums";

/**
 * Shape of `PolicyVersion.restrictionConfig` (§3). THIS TYPE IS THE SOURCE OF TRUTH.
 *
 * The Zod schema that validates API input (`restrictionConfigSchema` in `@workmode/validation`) must stay
 * structurally identical to this interface — `@workmode/shared` cannot depend on `@workmode/validation`
 * (it would be circular), so the validation package should assert equality at the type level, e.g.
 * `const _check: RestrictionConfig = {} as z.infer<typeof restrictionConfigSchema>;` and vice versa.
 *
 * Changing this type is a contract change for the iOS client (it decodes the same JSON) and must be
 * accompanied by a new PolicyVersion rather than an in-place edit of a published version.
 */
export interface RestrictionConfig {
  /** App categories shielded while Work Mode is active. */
  categories: RestrictionCategory[];
  /**
   * Whether the employee must pick concrete apps in the FamilyActivityPicker on their device. On iOS the
   * employer can never see or choose apps, so this is effectively always `true` for a working policy.
   */
  requireEmployeeAppSelection: boolean;
  /** Plain-language lines shown to the employee listing what is never blocked (Phone, Messages, ...). */
  alwaysAllowedNote: string[];
  /** Optional copy shown on the iOS shield; the client falls back to its own default when absent. */
  shieldMessage?: string;
  /** How Work Mode is activated: by schedule or by clock-in/out events from an integration. */
  activationMode: ActivationMode;
  /** Minutes before shift start at which the device enters SHIFT_STARTING_SOON. */
  preShiftWarningMinutes: number;
}

/**
 * Default config used when a manager creates a new policy. Deep-frozen: never mutate it, call
 * `createDefaultRestrictionConfig()` for an editable copy.
 */
export const DEFAULT_RESTRICTION_CONFIG: Readonly<RestrictionConfig> = Object.freeze({
  categories: Object.freeze([
    "SOCIAL_MEDIA",
    "GAMES",
    "ENTERTAINMENT",
    "STREAMING",
    "VIDEO",
    "SHOPPING",
    "DATING",
  ]) as unknown as RestrictionCategory[],
  requireEmployeeAppSelection: true,
  alwaysAllowedNote: Object.freeze([
    "Phone, Messages and FaceTime",
    "Maps, Camera and Clock",
    "Emergency SOS and Medical ID",
    "Any app your employer marks as a work app",
  ]) as unknown as string[],
  shieldMessage: "Work Mode is on. This app will be available again after your shift.",
  activationMode: "SCHEDULED",
  preShiftWarningMinutes: 10,
});

/** Returns a fresh, mutable copy of `DEFAULT_RESTRICTION_CONFIG`. */
export function createDefaultRestrictionConfig(): RestrictionConfig {
  return {
    categories: [...DEFAULT_RESTRICTION_CONFIG.categories],
    requireEmployeeAppSelection: DEFAULT_RESTRICTION_CONFIG.requireEmployeeAppSelection,
    alwaysAllowedNote: [...DEFAULT_RESTRICTION_CONFIG.alwaysAllowedNote],
    ...(DEFAULT_RESTRICTION_CONFIG.shieldMessage !== undefined
      ? { shieldMessage: DEFAULT_RESTRICTION_CONFIG.shieldMessage }
      : {}),
    activationMode: DEFAULT_RESTRICTION_CONFIG.activationMode,
    preShiftWarningMinutes: DEFAULT_RESTRICTION_CONFIG.preShiftWarningMinutes,
  };
}

const RESTRICTION_CATEGORY_SET: ReadonlySet<string> = new Set(RESTRICTION_CATEGORIES);
const ACTIVATION_MODE_SET: ReadonlySet<string> = new Set(ACTIVATION_MODES);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Structural runtime guard for JSON read back from `PolicyVersion.restrictionConfig`. This is NOT the API
 * validator (that is the Zod schema in `@workmode/validation`); it exists so `resolvePolicyVersion` can
 * return a truthfully-typed `RestrictionConfig` instead of an unchecked cast of `Prisma.JsonValue`.
 */
export function isRestrictionConfig(value: unknown): value is RestrictionConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!isStringArray(v.categories) || !v.categories.every((c) => RESTRICTION_CATEGORY_SET.has(c))) {
    return false;
  }
  if (typeof v.requireEmployeeAppSelection !== "boolean") return false;
  if (!isStringArray(v.alwaysAllowedNote)) return false;
  if (v.shieldMessage !== undefined && typeof v.shieldMessage !== "string") return false;
  if (typeof v.activationMode !== "string" || !ACTIVATION_MODE_SET.has(v.activationMode))
    return false;
  if (
    typeof v.preShiftWarningMinutes !== "number" ||
    !Number.isInteger(v.preShiftWarningMinutes) ||
    v.preShiftWarningMinutes < 0
  ) {
    return false;
  }
  return true;
}
