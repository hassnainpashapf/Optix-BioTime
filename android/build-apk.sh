#!/bin/bash
# Builds the Attendance Alerts APK. Everything it downloads (about 700 MB) goes into ~/android-build, so removing that folder removes it all.
# Safe to run again: downloads resume and finished steps are skipped.
set -e
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export PATH="$JAVA_HOME/bin:$PATH"
B=$HOME/android-build; SDK=$B/sdk; mkdir -p "$SDK" "$B"
dl() { # url file: resumable
  until curl -L -C - --retry 5 --retry-delay 3 --retry-all-errors -s -o "$2" "$1"; do echo "download interrupted, retrying $1"; sleep 5; done
}
cd "$B"
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  echo "== Android command-line tools"; dl https://dl.google.com/android/repository/commandlinetools-mac-11076708_latest.zip cmdtools.zip
  rm -rf ct && mkdir ct && unzip -q cmdtools.zip -d ct && mkdir -p "$SDK/cmdline-tools" && rm -rf "$SDK/cmdline-tools/latest" && mv ct/cmdline-tools "$SDK/cmdline-tools/latest"
fi
if [ ! -d "$SDK/platforms/android-34" ] || [ ! -d "$SDK/build-tools/34.0.0" ]; then
  echo "== Android SDK platform 34 and build tools"
  yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" --licenses >/dev/null || true
  until "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" "platforms;android-34" "build-tools;34.0.0"; do echo "retrying sdkmanager"; sleep 10; done
fi
if [ ! -x "$B/gradle-8.7/bin/gradle" ]; then
  echo "== Gradle 8.7"; dl https://services.gradle.org/distributions/gradle-8.7-bin.zip gradle.zip; unzip -q -o gradle.zip -d "$B"
fi
cd "$(dirname "$0")"
echo "sdk.dir=$SDK" > local.properties
echo "== building"
until "$B/gradle-8.7/bin/gradle" --no-daemon -q assembleDebug; do echo "build failed or interrupted, retrying (dependency downloads resume)"; sleep 15; [ -f app/build/outputs/apk/debug/app-debug.apk ] && break; done
mkdir -p ../public/downloads && cp app/build/outputs/apk/debug/app-debug.apk ../public/downloads/attendance-alerts.apk
ls -la ../public/downloads/attendance-alerts.apk
echo "BUILD OK"
