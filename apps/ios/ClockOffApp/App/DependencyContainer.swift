import Foundation
import WorkModeCore

/// Wires the app's dependencies. `shared` is the production graph; tests build their own with stubs.
final class DependencyContainer {
    let configuration: AppConfiguration
    let deviceInfo: DeviceInfoProviding
    let tokenStore: TokenStore
    let api: MobileAPI
    /// The App Group container (`state.json`, `plans.json`, selections) shared with the extensions.
    let fileStore: AppGroupFileStore
    let cache: StateCache
    let outbox: EventOutbox
    let plans: PlansStore
    let restrictionProvider: AppRestrictionProvider
    let selectionConfigurator: SelectionConfiguring?
    /// Whether the work and "keep blocked on breaks" selections exist (counts only).
    let selectionStatus: SelectionStatusProviding
    /// True when `MockRestrictionProvider` is in use (Debug builds): the UI shows the development banner.
    let isUsingMockRestrictions: Bool
    /// Flags shared with the extensions (App Group `UserDefaults`); nil when the suite cannot be opened.
    let sharedFlags: SharedFlags?
    let notifications: LocalNotificationScheduling
    let connectivity: ConnectivityMonitoring
    let syncMetadata: SyncMetadataStore
    let onboardingProgress: OnboardingProgressStore
    /// `POST /breaks/start` / `POST /breaks/:id/end` for `WorkModeController` and the offline-break replay.
    let breakAPI: BreakStarting
    let syncCoordinator: SyncCoordinator

    init(
        configuration: AppConfiguration,
        deviceInfo: DeviceInfoProviding,
        tokenStore: TokenStore,
        api: MobileAPI,
        fileStore: AppGroupFileStore,
        restriction: RestrictionProviderFactory.Choice,
        sharedFlags: SharedFlags? = nil,
        metadataStore: KeyValueStore? = nil,
        notifications: LocalNotificationScheduling? = nil,
        connectivity: ConnectivityMonitoring? = nil,
        now: @escaping () -> Date = Date.init
    ) {
        self.configuration = configuration
        self.deviceInfo = deviceInfo
        self.tokenStore = tokenStore
        self.api = api
        self.fileStore = fileStore
        cache = StateCache(fileStore: fileStore)
        outbox = EventOutbox(cache: cache)
        plans = PlansStore(fileStore: fileStore)
        restrictionProvider = restriction.provider
        selectionConfigurator = restriction.selectionConfigurator
        selectionStatus = (restriction.provider as? SelectionStatusProviding) ?? SelectionStoreStatus(store: SelectionStore(fileStore: fileStore))
        isUsingMockRestrictions = restriction.isMock
        let keyValueStore = metadataStore ?? UserDefaultsKeyValueStore(suiteName: AppGroup.identifier) ?? UserDefaultsKeyValueStore(defaults: .standard)
        self.sharedFlags = sharedFlags ?? SharedFlags(store: keyValueStore)
        self.notifications = notifications ?? UserNotificationScheduler()
        self.connectivity = connectivity ?? NetworkPathConnectivityMonitor()
        syncMetadata = SyncMetadataStore(store: keyValueStore)
        onboardingProgress = OnboardingProgressStore(store: keyValueStore)
        breakAPI = MobileAPIBreakClient(api: api)
        syncCoordinator = SyncCoordinator(
            api: api,
            cache: cache,
            outbox: outbox,
            plans: plans,
            provider: restriction.provider,
            deviceInfo: deviceInfo,
            breakAPI: breakAPI,
            notifications: self.notifications,
            metadata: syncMetadata,
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
            fatalError("ClockOff cannot create its data directory: \(error)")
        }
        let sharedDefaults: KeyValueStore = UserDefaultsKeyValueStore(suiteName: AppGroup.identifier)
            ?? UserDefaultsKeyValueStore(defaults: .standard)
        let flags = SharedFlags(store: sharedDefaults)
        #if DEBUG_MOCK_RESTRICTIONS
        let restriction = RestrictionProviderFactory.make(store: sharedDefaults)
        #else
        // Apple's provider; the picker shows the cached policy's categories as guidance.
        let cache = StateCache(fileStore: fileStore)
        let provider = AppleScreenTimeRestrictionProvider(fileStore: fileStore, flags: flags)
        let configurator = ScreenTimeSelectionConfigurator(
            selections: SelectionStore(fileStore: fileStore),
            flags: flags,
            policyCategories: { cache.load()?.policy?.restrictionConfig.categories ?? [] }
        )
        let restriction = RestrictionProviderFactory.Choice(provider: provider, selectionConfigurator: configurator, isMock: false)
        #endif
        return DependencyContainer(
            configuration: configuration,
            deviceInfo: SystemDeviceInfo(configuration: configuration),
            tokenStore: tokenStore,
            api: api,
            fileStore: fileStore,
            restriction: restriction,
            sharedFlags: flags,
            metadataStore: sharedDefaults
        )
    }
}
