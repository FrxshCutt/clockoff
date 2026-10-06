# Work Mode iOS — build, test and verify from the command line (see docs/IOS_SETUP.md).
#
#   make generate        regenerate WorkMode.xcodeproj from project.yml (XcodeGen)
#   make build           Debug build of the app + 3 extensions for the simulator (mock restrictions)
#   make test            WorkModeCore tests + hosted app tests on the simulator
#   make build-release   Release build for the simulator, then Scripts/verify-release.sh: fails if the
#                        mock provider, DEBUG/DEBUG_MOCK_RESTRICTIONS or the Debug-only ATS keys reach
#                        Release, or a target's bundle id / App Group / Family Controls entitlement is wrong
#   make clean           remove build output
#
# Simulator builds are unsigned (no signing identity is needed). Device builds need DEVELOPMENT_TEAM in the
# git-ignored Config/Signing.local.xcconfig and are run from Xcode (docs/IOS_SETUP.md).

# macOS ships GNU Make 3.81 (no .SHELLFLAGS): recipes that pipe xcodebuild set pipefail themselves so a
# failed build fails the make target.
SHELL := /bin/bash

PROJECT       := WorkMode.xcodeproj
SCHEME        := WorkModeApp
SIMULATOR     ?= iPhone 17 Pro
DESTINATION   ?= platform=iOS Simulator,name=$(SIMULATOR)
DERIVED_DATA  := build/DerivedData
RELEASE_DATA  := build/ReleaseDerivedData
NO_SIGNING    := CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""

# Pipe through xcbeautify/xcpretty when installed; plain xcodebuild output otherwise.
FORMATTER := $(shell command -v xcbeautify 2>/dev/null || command -v xcpretty 2>/dev/null || echo cat)

XCODEBUILD = set -o pipefail && xcodebuild -project $(PROJECT) -scheme $(SCHEME) -destination '$(DESTINATION)'

RELEASE_APP = $(RELEASE_DATA)/Build/Products/Release-iphonesimulator/WorkModeApp.app

.PHONY: generate build test build-release clean check-project

generate:
	xcodegen generate --spec project.yml

check-project:
	@test -d $(PROJECT) || { echo "error: $(PROJECT) missing — run 'make generate'"; exit 1; }

build: check-project
	$(XCODEBUILD) -configuration Debug -derivedDataPath $(DERIVED_DATA) $(NO_SIGNING) build | $(FORMATTER)

test: check-project
	$(XCODEBUILD) -configuration Debug -derivedDataPath $(DERIVED_DATA) $(NO_SIGNING) test | $(FORMATTER)

build-release: check-project
	$(XCODEBUILD) -configuration Release -derivedDataPath $(RELEASE_DATA) $(NO_SIGNING) build | $(FORMATTER)
	@echo "Verifying the Release configuration and product…"
	@Scripts/verify-release.sh "$(RELEASE_APP)"

clean:
	rm -rf build
