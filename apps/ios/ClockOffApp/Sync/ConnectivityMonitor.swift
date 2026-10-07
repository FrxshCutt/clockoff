import Foundation
import Network

/// Network reachability. A transition to "online" triggers a sync so queued events and offline breaks are
/// delivered as soon as the phone reconnects. The value is advisory only: requests are attempted regardless.
protocol ConnectivityMonitoring: AnyObject {
    var isOnline: Bool { get }
    /// Starts observing; `onChange` is called on an arbitrary thread whenever reachability flips.
    func start(onChange: @escaping (Bool) -> Void)
    func stop()
}

final class NetworkPathConnectivityMonitor: ConnectivityMonitoring {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "online.clockoff.app.connectivity")
    private let lock = NSLock()
    private var online = true
    private var started = false

    var isOnline: Bool {
        lock.lock()
        defer { lock.unlock() }
        return online
    }

    func start(onChange: @escaping (Bool) -> Void) {
        lock.lock()
        let alreadyStarted = started
        started = true
        lock.unlock()
        guard !alreadyStarted else { return }
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let now = path.status == .satisfied
            self.lock.lock()
            let changed = self.online != now
            self.online = now
            self.lock.unlock()
            if changed { onChange(now) }
        }
        monitor.start(queue: queue)
    }

    func stop() {
        monitor.cancel()
        lock.lock()
        started = false
        lock.unlock()
    }
}
