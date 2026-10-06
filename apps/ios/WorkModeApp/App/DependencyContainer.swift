import Foundation
import WorkModeCore

/// Wires the app's dependencies. `shared` is the production graph; tests build their own with stubs.
final class DependencyContainer {
    let configuration: AppConfiguration
    let deviceInfo: DeviceInfoProviding
    let tokenStore: TokenStore
    let api: MobileAPI
    let cache: StateCache
    let outbox: EventOutbox
    let plans: PlansStore
    let restrictionProvider: AppRestrictionProvider
    let selectionConfigurator: SelectionConfiguring?
    /// True when `MockRestrictionProvider` is in use (Debug builds): the UI shows the development banner.
    let isUsingMockRestrictions: Bool
    let syncCoordinator: SyncCoordinator

    init(
        configuration: AppConfiguration,
        deviceInfo: DeviceInfoProviding,
        tokenStore: TokenStore,
        api: MobileAPI,
        fileStore: AppGroupFileStore,
        restriction: RestrictionProviderFactory.Choice,
        now: @escaping () -> Date = Date.init
    ) {
        self.configuration = configuration
        self.deviceInfo = deviceInfo
        self.tokenStore = tokenStore
        self.api = api
        cache = StateCache(fileStore: fileStore)
        outbox = EventOutbox(cache: cache)
        plans = PlansStore(fileStore: fileStore)
        restrictionProvider = restriction.provider
        selectionConfigurator = restriction.selectionConfigurator
        isUsingMockRestrictions = restriction.isMock
        syncCoordinator = SyncCoordinator(
            api: api,
            cache: cache,
            outbox: outbox,
            plans: plans,
            provider: restriction.provider,
            deviceInfo: deviceInfo,
            now: now
        )
    }

    static let shared: DependencyContainer = .live()

    private static func live() -> DependencyContainer {
        let configuration = AppConfiguration.load()
        #if DEBUG && targetEnvironment(simulator)
        // Unsigned simulator builds have no Keychain access group (see SimulatorTokenStore).
        let persistentTokenStore: TokenStore = SimulatorTokenStore()
        #else
        let persistentTokenStore: TokenStore = KeychainTokenStore()
        #endif
        // One shared instance for the API client, its refresher and sign-out: a rotated pair the Keychain
        // refuses is kept in memory rather than lost (single-use refresh tokens, see ResilientTokenStore).
        let tokenStore: TokenStore = ResilientTokenStore(base: persistentTokenStore)
        let api = APIClient(configuration: APIClientConfiguration(baseURL: configuration.apiBaseURL), tokenStore: tokenStore)
        let fileStore: AppGroupFileStore
        do {
            fileStore = try AppGroupFileStore.live()
        } catch {
            fatalError("Work Mode cannot create its data directory: \(error)")
        }
        let sharedDefaults: KeyValueStore = UserDefaultsKeyValueStore(suiteName: AppGroup.identifier)
            ?? UserDefaultsKeyValueStore(defaults: .standard)
        return DependencyContainer(
            configuration: configuration,
            deviceInfo: SystemDeviceInfo(configuration: configuration),
            tokenStore: tokenStore,
            api: api,
            fileStore: fileStore,
            restriction: RestrictionProviderFactory.make(store: sharedDefaults)
        )
    }
}
