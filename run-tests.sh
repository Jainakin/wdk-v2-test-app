#!/bin/bash
# WDK v2 — Full test cycle script
# Usage: bash run-tests.sh [--rebuild-native]

SIM="83B54EF8-D78F-40B3-8826-2A32078ED6AB"
BUNDLE_ID="org.reactjs.native.example.WDKTestApp"
REBUILD_NATIVE=false

if [ "$1" = "--rebuild-native" ]; then
  REBUILD_NATIVE=true
fi

echo "═══ Step 1: Shutdown ═══"
pkill -f "react-native start" 2>/dev/null
pkill -f "metro" 2>/dev/null
pkill -f "@react-native" 2>/dev/null
xcrun simctl terminate "$SIM" "$BUNDLE_ID" 2>/dev/null
sleep 1

echo "═══ Step 2: Rebuild bundle ═══"
cd /Users/hardik/Desktop/wdk-v2/working && bash build-and-copy.sh 2>&1 | tail -3

if [ "$REBUILD_NATIVE" = true ]; then
  echo "═══ Step 3: Native rebuild ═══"
  cd /Users/hardik/Desktop/wdk-v2/working/WDKTestApp
  # Build only — don't launch yet (Metro isn't running)
  xcodebuild -workspace ios/WDKTestApp.xcworkspace \
    -scheme WDKTestApp \
    -sdk iphonesimulator \
    -destination "id=$SIM" \
    -configuration Debug \
    build 2>&1 | tail -3
  # Install the built app
  APP_PATH=$(find ~/Library/Developer/Xcode/DerivedData/WDKTestApp-*/Build/Products/Debug-iphonesimulator/WDKTestApp.app -maxdepth 0 2>/dev/null | head -1)
  if [ -n "$APP_PATH" ]; then
    xcrun simctl install "$SIM" "$APP_PATH"
    echo "Installed: $APP_PATH"
  fi
fi

echo "═══ Step 4: Start Metro ═══"
cd /Users/hardik/Desktop/wdk-v2/working/WDKTestApp
rm -f /tmp/metro-output.txt
npx react-native start > /tmp/metro-output.txt 2>&1 &
METRO_PID=$!
for i in $(seq 1 20); do
  grep -q "Dev server ready" /tmp/metro-output.txt 2>/dev/null && echo "Metro ready (${i}s)" && break
  sleep 1
done

echo "═══ Step 5: Launch app ═══"
xcrun simctl launch "$SIM" "$BUNDLE_ID"

echo "═══ Step 6: Waiting for tests (30s) ═══"
sleep 30

echo "═══ Step 7: Results ═══"
APP_CONTAINER=$(xcrun simctl get_app_container "$SIM" "$BUNDLE_ID" data 2>/dev/null)
RESULTS_FILE="$APP_CONTAINER/tmp/wdk-test-results.txt"

if [ -f "$RESULTS_FILE" ]; then
  cat "$RESULTS_FILE"
else
  echo "ERROR: Results file not found at $RESULTS_FILE"
  echo "Taking screenshot as fallback..."
  xcrun simctl io "$SIM" screenshot /tmp/wdk-test-results.png
  echo "Screenshot saved to /tmp/wdk-test-results.png"
fi

echo ""
echo "═══ Step 8: Shutdown ═══"
xcrun simctl terminate "$SIM" "$BUNDLE_ID" 2>/dev/null
kill $METRO_PID 2>/dev/null
pkill -f "react-native start" 2>/dev/null
pkill -f "metro" 2>/dev/null
echo "Done."
