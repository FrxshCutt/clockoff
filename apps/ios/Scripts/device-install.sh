#!/usr/bin/env bash
# Build the Debug configuration for the first connected, paired iPhone, install it and launch it
# (`make device-install`). Debug device builds use production and Apple's real Screen Time provider
# (Config/Debug.xcconfig [sdk=iphoneos*]). Automatic signing for DEVELOPMENT_TEAM; -allowProvisioningUpdates lets
# Xcode create the development certificate/profiles and register the phone using the Apple ID in Xcode.
set -euo pipefail
cd "$(dirname "$0")/.."
json="$(mktemp)"; trap 'rm -f "$json"' EXIT
xcrun devicectl list devices --json-output "$json" >/dev/null
read -r core udid name < <(python3 - "$json" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1]))["result"]["devices"]
for d in devices:
    hw, conn = d.get("hardwareProperties", {}), d.get("connectionProperties", {})
    if hw.get("platform") == "iOS" and conn.get("pairingState") == "paired" and hw.get("reality") == "physical":
        print(d["identifier"], hw.get("udid", ""), d.get("deviceProperties", {}).get("name", "iPhone").replace(" ", "_"))
        break
PY
) || true
if [ -z "${core:-}" ]; then
  echo "No paired iPhone found. Plug it in, unlock it, tap Trust, and enable Developer Mode" >&2
  echo "(Settings → Privacy & Security → Developer Mode, then restart)." >&2
  exit 1
fi
echo "Building Debug for ${name//_/ } ($udid)…"
set -o pipefail
xcodebuild -project ClockOff.xcodeproj -scheme ClockOffApp -configuration Debug \
  -destination "platform=iOS,id=$udid" -derivedDataPath build/DeviceDerivedData -allowProvisioningUpdates build | ${FORMATTER:-cat}
app="build/DeviceDerivedData/Build/Products/Debug-iphoneos/ClockOffApp.app"
echo "Embedded extensions: $(ls "$app/PlugIns" | tr '\n' ' ')"
xcrun devicectl device install app --device "$core" "$app"
xcrun devicectl device process launch --device "$core" --terminate-existing online.clockoff.app
