import { apnsConfigured, env } from "@/lib/env";
import { ApnsPushProvider } from "./ApnsPushProvider";
import { NoopPushProvider } from "./NoopPushProvider";
import type { PushProvider } from "./PushProvider";

export { APNS_HOSTS, ApnsPushProvider } from "./ApnsPushProvider";
export type { ApnsConfig, ApnsRequest } from "./ApnsPushProvider";
export { NoopPushProvider } from "./NoopPushProvider";
export type {
  AlertPushPayload,
  PushFailure,
  PushProvider,
  PushReport,
  SilentPushPayload,
} from "./PushProvider";

/** APNs when every APNS_* variable is set; otherwise the logging no-op. */
export function createPushProvider(): PushProvider {
  const e = env();
  if (apnsConfigured(e)) {
    return ApnsPushProvider.fromBase64Key({
      keyId: e.APNS_KEY_ID!,
      teamId: e.APNS_TEAM_ID!,
      p8Base64: e.APNS_P8_BASE64!,
      bundleId: e.APNS_BUNDLE_ID,
      environment: e.APNS_ENVIRONMENT,
    });
  }
  return new NoopPushProvider();
}

declare global {
  var __clockoffPushProvider: PushProvider | undefined;
}

export function getPushProvider(): PushProvider {
  if (!globalThis.__clockoffPushProvider) globalThis.__clockoffPushProvider = createPushProvider();
  return globalThis.__clockoffPushProvider;
}

export function setPushProviderForTesting(provider: PushProvider | undefined): void {
  globalThis.__clockoffPushProvider = provider;
}
