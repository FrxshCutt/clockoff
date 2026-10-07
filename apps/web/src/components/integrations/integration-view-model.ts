import type { ActivationMode, IntegrationProvider } from "@clockoff/shared/enums";
import type { Integration } from "@clockoff/validation/integrations";

/** Pure helpers behind the Integrations page: logo initials, URL segments, activation-mode copy and card state. */

/** "Planday" → "PL", "When I Work" → "WI", "7shifts" → "7S". Used for the logo placeholder. */
export function providerInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length >= 2) return `${words[0]!.charAt(0)}${words[1]!.charAt(0)}`.toUpperCase();
  return words[0]!.slice(0, 2).toUpperCase();
}

/** `WHEN_I_WORK` → `when-i-work`, the form `integrationProviderParamSchema` accepts in `/api/integrations/:provider/*`. */
export function providerPathSegment(provider: IntegrationProvider): string {
  return provider.toLowerCase().replace(/_/g, "-");
}

export interface ActivationModeCopy {
  readonly label: string;
  readonly summary: string;
  readonly detail: string;
}

export const ACTIVATION_MODE_COPY: Record<ActivationMode, ActivationModeCopy> = {
  SCHEDULED: {
    label: "Scheduled",
    summary: "Follows the rota.",
    detail:
      "Work Mode switches on at each synced shift's start time and off at its end, exactly as with shifts you add or import yourself. Best when the rota is reliable and people start on time.",
  },
  CLOCK_EVENT: {
    label: "Clock-in",
    summary: "Follows clock-in and clock-out.",
    detail:
      "Work Mode starts when the employee clocks in through the provider and ends when they clock out, so it tracks the shift they actually worked. Breaks punched in the provider relax restrictions too.",
  },
};

export type IntegrationCardState =
  "coming-soon" | "not-connected" | "connected" | "error" | "disconnected";

/** Availability first (a provider that isn't built can't be connected), then the stored connection status. */
export function integrationCardState(
  integration: Pick<Integration, "availability" | "status">,
): IntegrationCardState {
  if (integration.availability === "COMING_SOON") return "coming-soon";
  switch (integration.status) {
    case "CONNECTED":
      return "connected";
    case "ERROR":
      return "error";
    case "DISCONNECTED":
      return "disconnected";
    case "NOT_CONNECTED":
      return "not-connected";
  }
}

/** "Scheduled or Clock-in" / "Scheduled" for a card's activation line. */
export function describeActivationModes(modes: readonly ActivationMode[]): string {
  const labels = modes.map((mode) => ACTIVATION_MODE_COPY[mode].label);
  if (labels.length === 0) return "—";
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

/** Only http(s) links are rendered, so a bad `website` value can never become a `javascript:` link. */
export function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Hostname without "www." for the website link label. */
export function websiteLabel(value: string): string {
  const safe = safeExternalUrl(value);
  if (!safe) return "";
  return new URL(safe).hostname.replace(/^www\./, "");
}

export const INTEGRATIONS_EXPLAINER = {
  title: "Keep shifts in sync automatically",
  body: "Connect the software you already schedule in and ClockOff will import employees, locations, teams, shifts and clock events, so phones always know when a shift starts. Nothing about any phone is ever sent back to the provider.",
  comingSoon:
    "Every provider below is coming soon. Ask to be notified and we'll email you the moment yours is ready. In the meantime, CSV import brings in your rota in a couple of minutes.",
} as const;
