#!/usr/bin/env bash
# Archive the Release configuration and upload it to App Store Connect / TestFlight (`make testflight`).
#
# Build number: date-based (YYYYMMDDHHMM, UTC) unless BUILD_NUMBER is set; the marketing version comes from
# Config/Base.xcconfig (MARKETING_VERSION). Signing is automatic for team DEVELOPMENT_TEAM (Signing.xcconfig).
#
# Authentication, in order of preference:
#   1. App Store Connect API key: ASC_API_KEY_ID, ASC_API_ISSUER_ID and ASC_API_KEY_PATH (a .p8 file outside the
#      repo). Read from the environment, else from the repo's git-ignored .env.deploy.
#   2. The Apple ID signed into Xcode (Xcode → Settings → Accounts), used by -allowProvisioningUpdates.
# With an API key the script then waits for App Store Connect to finish processing (Scripts/asc-build-status.mjs).
set -euo pipefail
cd "$(dirname "$0")/.."

env_file="../../.env.deploy"
read_var() { # <name>: environment first, then .env.deploy (only these few non-secret ids/paths are read)
  local value="${!1:-}"
  if [ -z "$value" ] && [ -f "$env_file" ]; then
    value="$(sed -n "s/^$1=//p" "$env_file" | head -1 | tr -d '[:space:]')"
  fi
  printf '%s' "$value"
}
ASC_API_KEY_ID="$(read_var ASC_API_KEY_ID)"
ASC_API_ISSUER_ID="$(read_var ASC_API_ISSUER_ID)"
ASC_API_KEY_PATH="$(read_var ASC_API_KEY_PATH)"
ASC_API_KEY_PATH="${ASC_API_KEY_PATH/#\~/$HOME}"

auth=()
if [ -n "$ASC_API_KEY_ID" ] && [ -n "$ASC_API_ISSUER_ID" ] && [ -f "$ASC_API_KEY_PATH" ]; then
  auth=(-authenticationKeyPath "$ASC_API_KEY_PATH" -authenticationKeyID "$ASC_API_KEY_ID" -authenticationKeyIssuerID "$ASC_API_ISSUER_ID")
  echo "Authenticating with App Store Connect API key $ASC_API_KEY_ID."
else
  echo "No App Store Connect API key file found (ASC_API_KEY_PATH); using the Apple ID signed into Xcode."
fi

BUILD_NUMBER="${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"
archive="build/ClockOff-$BUILD_NUMBER.xcarchive"
export_dir="build/export-$BUILD_NUMBER"
echo "Archiving Release, build $BUILD_NUMBER…"
set -o pipefail
xcodebuild -project ClockOff.xcodeproj -scheme ClockOffApp -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$archive" \
  -allowProvisioningUpdates ${auth[@]+"${auth[@]}"} \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" archive | ${FORMATTER:-cat}

app="$archive/Products/Applications/ClockOffApp.app"
echo "Checking the archived product…"
Scripts/verify-release.sh "$app"

echo "Exporting and uploading to App Store Connect…"
xcodebuild -exportArchive -archivePath "$archive" -exportOptionsPlist ExportOptions.plist \
  -exportPath "$export_dir" -allowProvisioningUpdates ${auth[@]+"${auth[@]}"} | ${FORMATTER:-cat}
echo "Uploaded build $BUILD_NUMBER (version $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Info.plist"))."

if [ ${#auth[@]} -gt 0 ]; then
  node Scripts/asc-build-status.mjs --key "$ASC_API_KEY_PATH" --key-id "$ASC_API_KEY_ID" --issuer "$ASC_API_ISSUER_ID" \
    --bundle-id online.clockoff.app --build "$BUILD_NUMBER" --wait
else
  echo "Processing status: check App Store Connect → ClockOff → TestFlight (no API key to poll with)."
fi
