import Foundation

/// Serialises access-token refreshes. However many requests hit a 401 at once, exactly one
/// `POST /auth/refresh` is in flight; every caller awaits its result. This matters because refresh tokens
/// are single-use: two concurrent refreshes with the same token would trip the server's reuse detection
/// and revoke the device's session. (Wrap the persistent store in `ResilientTokenStore` so a rotated pair
/// that cannot be persisted is not lost either.)
public actor TokenRefresher {
    public typealias RefreshOperation = @Sendable (_ refreshToken: String) async throws -> TokenPair

    private let tokenStore: TokenStore
    private let operation: RefreshOperation
    private var inFlight: Task<TokenPair, Error>?

    public init(tokenStore: TokenStore, operation: @escaping RefreshOperation) {
        self.tokenStore = tokenStore
        self.operation = operation
    }

    /// The stored access token. Throws `NOT_SIGNED_IN` when there are no tokens and
    /// `CREDENTIALS_UNAVAILABLE` when they cannot be read (Keychain locked or failing) — the latter is not an
    /// authentication failure: the session is intact.
    public func accessToken() throws -> String {
        try storedTokens().accessToken
    }

    /// A refreshed access token. `rejected` is the token the server just refused: when the stored token
    /// already differs (another request refreshed meanwhile) it is returned without a new refresh.
    /// On an authentication failure (reused/expired/revoked refresh token, deactivated device) the stored
    /// tokens are deleted and the error is rethrown.
    public func refreshedAccessToken(rejected: String?) async throws -> String {
        try await refreshedTokens(rejected: rejected).accessToken
    }

    public func refreshedTokens(rejected: String?) async throws -> TokenPair {
        if let inFlight {
            return try await inFlight.value
        }
        let tokens = try storedTokens()
        if let rejected, tokens.accessToken != rejected {
            return tokens
        }
        let store = tokenStore
        let operation = self.operation
        let refreshToken = tokens.refreshToken
        let task = Task<TokenPair, Error> {
            do {
                let pair = try await operation(refreshToken)
                try store.saveTokens(pair)
                return pair
            } catch let error as APIError where error.isAuthenticationFailure {
                try? store.deleteTokens()
                throw error
            }
        }
        inFlight = task
        defer { inFlight = nil }
        return try await task.value
    }

    private func storedTokens() throws -> TokenPair {
        let tokens: TokenPair?
        do {
            tokens = try tokenStore.loadTokens()
        } catch {
            WorkModeLog.network.error("stored tokens unreadable: \(String(describing: error), privacy: .public)")
            throw APIError.credentialsUnavailable()
        }
        guard let tokens else { throw APIError.notSignedIn() }
        return tokens
    }
}
