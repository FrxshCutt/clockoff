#!/bin/bash
# Verifies a Release build of Work Mode (run by `make build-release` after the build).
#
#   Scripts/verify-release.sh <path to Release WorkModeApp.app>
#
# Fails (exit 1) when:
#   - any target's Release build settings define DEBUG or DEBUG_MOCK_RESTRICTIONS, or a bundle id is wrong;
#   - a target's entitlements lack the App Group or Family Controls;
#   - the Release binary contains the mock restriction provider or the simulator token store;
#   - the Debug-only ATS / local-network Info.plist keys are present, or API_BASE_URL is not https;
#   - one of the three extensions is not embedded.
set -euo pipefail

APP="${1:?usage: verify-release.sh <WorkModeApp.app>}"
cd "$(dirname "$0")/.."

PROJECT=WorkMode.xcodeproj
APP_GROUP=group.com.workmode.app.shared
PLISTBUDDY=/usr/libexec/PlistBuddy
failures=0

fail() {
  echo "error: $*" >&2
  failures=$((failures + 1))
}

setting() { # <settings text> <name>
  printf '%s\n' "$1" | awk -F ' = ' -v key="$2" '$1 ~ "^ *" key "$" { print $2; exit }'
}

# target:bundle id
TARGETS=(
  "WorkModeApp:com.workmode.app"
  "WorkModeDeviceActivityMonitor:com.workmode.app.devicemonitor"
  "WorkModeShieldConfiguration:com.workmode.app.shieldconfig"
  "WorkModeShieldAction:com.workmode.app.shieldaction"
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

[ -f "$APP/WorkModeApp" ] || { echo "error: $APP/WorkModeApp not found — did the Release build run?" >&2; exit 1; }
# Every executable and dylib in the bundle (the app, the extensions, any debug dylib).
while IFS= read -r -d '' binary; do
  for symbol in MockRestrictionProvider SimulatorTokenStore "DEVELOPMENT MODE"; do
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
  https://*) echo "  Release API_BASE_URL: $url" ;;
  *) fail "Release API_BASE_URL must be https, got '$url'" ;;
esac
push="$($PLISTBUDDY -c "Print :WorkModePushEnvironment" "$INFO" 2>/dev/null || true)"
[ "$push" = "production" ] || fail "Release WorkModePushEnvironment is '$push', expected 'production'"

for ext in WorkModeDeviceActivityMonitor WorkModeShieldConfiguration WorkModeShieldAction; do
  [ -d "$APP/PlugIns/$ext.appex" ] || fail "$ext.appex is not embedded"
done

if [ "$failures" -gt 0 ]; then
  echo "Release verification FAILED ($failures problem(s))." >&2
  exit 1
fi
echo "Release product OK: no mock provider or simulator token store, no Debug-only keys, https API," \
  "production push, 4 targets with correct bundle ids, App Group and Family Controls, 3 extensions embedded."
