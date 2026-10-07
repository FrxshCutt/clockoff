#!/bin/bash
# Verifies a Release build of ClockOff (run by `make build-release` after the build).
#
#   Scripts/verify-release.sh <path to Release ClockOffApp.app>
#
# Fails (exit 1) when:
#   - any target's Release build settings define DEBUG or DEBUG_MOCK_RESTRICTIONS, or a bundle id is wrong;
#   - a target's entitlements lack the App Group or Family Controls;
#   - the Release binary contains the mock restriction provider or the simulator token store;
#   - the Release binary contains the Debug-only Diagnostics screen (its report title "ClockOff Diagnostics",
#     the DiagnosticsSnapshot model or the DiagnosticsUnlock tap counter behind Settings › App version);
#   - the Debug-only ATS / local-network Info.plist keys are present;
#   - API_BASE_URL is not https, or is not the mobile API root (its path must end with /api/mobile/v1, exactly
#     once, with no empty segment);
#   - one of the three extensions is not embedded.
set -euo pipefail

APP="${1:?usage: verify-release.sh <ClockOffApp.app>}"
cd "$(dirname "$0")/.."

PROJECT=ClockOff.xcodeproj
APP_GROUP=group.online.clockoff.app.shared
PLISTBUDDY=/usr/libexec/PlistBuddy
# API_BASE_URL is the mobile API root: https://<host>[/<segment>…]/api/mobile/v1 (no trailing slash, query,
# fragment, user info or empty `//` segment).
API_ROOT_PATH=/api/mobile/v1
API_ROOT_RE='^https://[^/?#@[:space:]]+(/[^/?#[:space:]]+)*/api/mobile/v1$'
failures=0

fail() {
  echo "error: $*" >&2
  failures=$((failures + 1))
}

setting() { # <settings text> <name>
  # Reads all of its input (no early `exit`): under `set -o pipefail` an early exit can kill the writer with
  # SIGPIPE (status 141) once the settings dump is larger than the pipe buffer.
  printf '%s\n' "$1" | awk -F ' = ' -v key="$2" '!found && $1 ~ "^ *" key "$" { print $2; found = 1 }'
}

# target:bundle id
TARGETS=(
  "ClockOffApp:online.clockoff.app"
  "ClockOffDeviceActivityMonitor:online.clockoff.app.devicemonitor"
  "ClockOffShieldConfiguration:online.clockoff.app.shieldconfig"
  "ClockOffShieldAction:online.clockoff.app.shieldaction"
)

for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  expected_id="${entry#*:}"
  settings="$(xcodebuild -project "$PROJECT" -target "$target" -configuration Release -showBuildSettings 2>/dev/null)"

  bundle_id="$(setting "$settings" PRODUCT_BUNDLE_IDENTIFIER)"
  [ "$bundle_id" = "$expected_id" ] || fail "$target bundle id is '$bundle_id', expected '$expected_id'"

  conditions=" $(setting "$settings" SWIFT_ACTIVE_COMPILATION_CONDITIONS) "
  case "$conditions" in
    *" DEBUG_MOCK_RESTRICTIONS "*) fail "$target Release defines DEBUG_MOCK_RESTRICTIONS" ;;
  esac
  case "$conditions" in
    *" DEBUG "*) fail "$target Release defines DEBUG" ;;
  esac

  entitlements="$(setting "$settings" CODE_SIGN_ENTITLEMENTS)"
  if [ -z "$entitlements" ] || [ ! -f "$entitlements" ]; then
    fail "$target has no entitlements file ('$entitlements')"
  else
    group="$($PLISTBUDDY -c "Print :com.apple.security.application-groups:0" "$entitlements" 2>/dev/null || true)"
    [ "$group" = "$APP_GROUP" ] || fail "$target entitlements: App Group is '$group', expected '$APP_GROUP'"
    family="$($PLISTBUDDY -c "Print :com.apple.developer.family-controls" "$entitlements" 2>/dev/null || true)"
    [ "$family" = "true" ] || fail "$target entitlements: com.apple.developer.family-controls is not true"
  fi
  echo "  $target: $bundle_id, conditions:[${conditions// /}], entitlements OK"
done

[ -f "$APP/ClockOffApp" ] || { echo "error: $APP/ClockOffApp not found — did the Release build run?" >&2; exit 1; }
# Every executable and dylib in the bundle (the app, the extensions, any debug dylib).
# The Diagnostics markers: DiagnosticsReport.title (a string literal longer than 15 bytes, so Swift stores it
# as a C string) and the type names the screen's #if DEBUG files declare (kept in Swift type metadata).
DEBUG_ONLY_MARKERS=(MockRestrictionProvider SimulatorTokenStore "DEVELOPMENT MODE" "ClockOff Diagnostics" DiagnosticsSnapshot DiagnosticsUnlock)
while IFS= read -r -d '' binary; do
  for symbol in "${DEBUG_ONLY_MARKERS[@]}"; do
    if /usr/bin/grep -q -a "$symbol" "$binary"; then
      fail "'$symbol' is compiled into ${binary#"$APP"/}"
    fi
  done
done < <(find "$APP" -type f \( -perm -u+x -o -name '*.dylib' \) -print0)

INFO="$APP/Info.plist"
if $PLISTBUDDY -c "Print :NSAppTransportSecurity:NSAllowsLocalNetworking" "$INFO" >/dev/null 2>&1; then
  fail "the Debug-only ATS exception (NSAllowsLocalNetworking) is in the Release Info.plist"
fi
if $PLISTBUDDY -c "Print :NSLocalNetworkUsageDescription" "$INFO" >/dev/null 2>&1; then
  fail "the Debug-only NSLocalNetworkUsageDescription is in the Release Info.plist"
fi
url="$($PLISTBUDDY -c "Print :API_BASE_URL" "$INFO" 2>/dev/null || true)"
case "$url" in
  https://*) ;;
  *) fail "Release API_BASE_URL must be https, got '$url'" ;;
esac
if [[ ! "$url" =~ $API_ROOT_RE ]]; then
  fail "Release API_BASE_URL must be the mobile API root, an https URL whose path ends with $API_ROOT_PATH" \
    "(no trailing slash, query, fragment or empty '//' segment), got '$url'"
elif [[ "$url" == *"$API_ROOT_PATH/"* ]]; then
  # The suffix is the only place it may appear: a doubled prefix would put every request under a 404.
  fail "Release API_BASE_URL repeats $API_ROOT_PATH, got '$url'"
else
  echo "  Release API_BASE_URL: $url"
fi
push="$($PLISTBUDDY -c "Print :ClockOffPushEnvironment" "$INFO" 2>/dev/null || true)"
[ "$push" = "production" ] || fail "Release ClockOffPushEnvironment is '$push', expected 'production'"

for ext in ClockOffDeviceActivityMonitor ClockOffShieldConfiguration ClockOffShieldAction; do
  [ -d "$APP/PlugIns/$ext.appex" ] || fail "$ext.appex is not embedded"
done

if [ "$failures" -gt 0 ]; then
  echo "Release verification FAILED ($failures problem(s))." >&2
  exit 1
fi
echo "Release product OK: no mock provider, simulator token store or Diagnostics screen, no Debug-only keys, https API at $API_ROOT_PATH," \
  "production push, 4 targets with correct bundle ids, App Group and Family Controls, 3 extensions embedded."
