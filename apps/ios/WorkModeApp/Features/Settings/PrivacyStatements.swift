import Foundation

/// What the employer can and cannot see (§12). Mirrors CAN_SEE / CANNOT_SEE in
/// packages/shared/src/privacyStatements.ts — keep the two in sync (that file also generates docs/PRIVACY.md).
struct PrivacyStatement: Identifiable, Equatable {
    let id: String
    let label: String
    let detail: String
}

enum PrivacyStatements {
    static let principle = "Block distractions. Don't spy on employees."

    static let canSee: [PrivacyStatement] = [
        PrivacyStatement(id: "connection", label: "Whether you have joined and your phone is connected",
                         detail: "Your setup stage (not invited, invited, joined, setup incomplete, connected or deactivated) and whether Work Mode is active on your phone."),
        PrivacyStatement(id: "permissionState", label: "Whether Screen Time access is granted",
                         detail: "Only the state of the authorisation: not determined, approved, denied or revoked. Never anything the permission gives access to."),
        PrivacyStatement(id: "selectionCounts", label: "Whether apps have been selected, and how many",
                         detail: "How many categories, apps and websites you chose. Never which ones: your choice stays on this phone as opaque Apple tokens that neither your employer nor Work Mode's servers can read."),
        PrivacyStatement(id: "workModeState", label: "Whether Work Mode is active right now",
                         detail: "Off shift, starting soon, working, on break, shift ending, manager override, permission error or sync error. It confirms whether shields are applied, not what you are doing."),
        PrivacyStatement(id: "breaks", label: "Break start and end times during a shift",
                         detail: "When a break started and ended and how many you took, so they can be checked against the break rules."),
        PrivacyStatement(id: "syncTimes", label: "When your phone last synced",
                         detail: "Timestamps of the last check-in, policy sync and schedule sync."),
        PrivacyStatement(id: "deviceBasics", label: "App version, iOS version and generic device model",
                         detail: "For support only, for example app 1.2.0 on iOS 17.5 on an iPhone. No serial number, IMEI, phone number or advertising ID."),
        PrivacyStatement(id: "clock", label: "Your phone's timezone and clock difference",
                         detail: "The timezone setting (for example Europe/London) and how far your clock is from server time, so shifts start on time. A timezone is a region setting, not a location."),
        PrivacyStatement(id: "activity", label: "A timeline of operational events",
                         detail: "Events from a fixed list, such as setup completed, Work Mode started or ended, break started or ended. Each has a time and no free text."),
        PrivacyStatement(id: "schedule", label: "The shifts, policies and break rules your employer created",
                         detail: "This is your employer's own data, not something observed from your phone."),
    ]

    static let cannotSee: [PrivacyStatement] = [
        PrivacyStatement(id: "messages", label: "Messages and calls",
                         detail: "No iMessage, SMS, WhatsApp, email or call content or history. The Screen Time frameworks Work Mode uses do not expose them at all."),
        PrivacyStatement(id: "photos", label: "Photos, videos, camera and files",
                         detail: "Work Mode does not ask for access to Photos, the camera, the microphone or files."),
        PrivacyStatement(id: "browsing", label: "Browsing history and searches",
                         detail: "No websites visited, search terms or other web activity."),
        PrivacyStatement(id: "appUsage", label: "App usage, screen time or which apps you opened",
                         detail: "Work Mode only schedules shields around your shifts and receives no usage reports."),
        PrivacyStatement(id: "selectedApps", label: "Which apps, categories or websites you chose",
                         detail: "Your choices stay on this phone and are never uploaded; only counts are sent."),
        PrivacyStatement(id: "notifications", label: "Notifications",
                         detail: "Neither the content nor the existence of notifications from other apps."),
        PrivacyStatement(id: "location", label: "Location",
                         detail: "Work Mode does not use Location Services, Wi-Fi or Bluetooth scanning."),
        PrivacyStatement(id: "personalData", label: "Contacts, calendar, health, passwords, keystrokes or screenshots",
                         detail: "Work Mode requests none of these permissions."),
        PrivacyStatement(id: "offShift", label: "What happens on your phone outside shifts",
                         detail: "Shields lift when your shift ends. Off shift, Work Mode only performs routine sync check-ins."),
    ]
}
