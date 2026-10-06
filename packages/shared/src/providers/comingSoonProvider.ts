import { AppError } from "../errors";
import type {
  ConnectionStatus,
  ConnectParams,
  ConnectResult,
  ProviderContext,
  ProviderId,
  SyncRange,
  SyncReport,
  WorkforceProvider,
} from "./workforceProvider";

/**
 * Placeholder implementation for providers that are listed but not yet built (§6.6 "Coming Soon" UX).
 * Every method rejects with `AppError("COMING_SOON")` (HTTP 501) so API routes behave consistently and the
 * dashboard can render the provider card with a "Notify me" action instead of a connect form.
 */
export class ComingSoonProvider implements WorkforceProvider {
  readonly status = "COMING_SOON" as const;

  constructor(
    readonly id: ProviderId,
    readonly displayName: string,
  ) {}

  private comingSoon(): never {
    throw new AppError("COMING_SOON", `${this.displayName} integration is coming soon`, {
      details: { provider: this.id },
    });
  }

  async connect(_ctx: ProviderContext, _params: ConnectParams): Promise<ConnectResult> {
    return this.comingSoon();
  }

  async disconnect(_ctx: ProviderContext): Promise<void> {
    return this.comingSoon();
  }

  async refreshAuthentication(_ctx: ProviderContext): Promise<void> {
    return this.comingSoon();
  }

  async syncEmployees(_ctx: ProviderContext): Promise<SyncReport> {
    return this.comingSoon();
  }

  async syncShifts(_ctx: ProviderContext, _range: SyncRange): Promise<SyncReport> {
    return this.comingSoon();
  }

  async syncLocations(_ctx: ProviderContext): Promise<SyncReport> {
    return this.comingSoon();
  }

  async syncTeams(_ctx: ProviderContext): Promise<SyncReport> {
    return this.comingSoon();
  }

  async syncClockEvents(_ctx: ProviderContext, _since: Date): Promise<SyncReport> {
    return this.comingSoon();
  }

  async getConnectionStatus(_ctx: ProviderContext): Promise<ConnectionStatus> {
    return this.comingSoon();
  }
}
