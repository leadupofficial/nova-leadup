#!/bin/bash
set -e

echo "🔐 Step 1: Authenticate with Expo/EAS"
echo "This will open a browser window for login."
echo ""
read -p "Press Enter when you're ready to login..."
eas login

echo ""
echo "🔗 Step 2: Link EAS project (if not already linked)"
cd apps/mobile
eas init || echo "Project already linked"

echo ""
echo "🚀 Step 3: Start Android APK build"
echo "This will upload your code to Expo's cloud and build the APK."
echo "Build time: ~5-10 minutes"
echo "You'll get a download link when complete."
echo ""
read -p "Press Enter to start the build..."
eas build --platform android --profile preview --non-interactive

echo ""
echo "✅ Build started! Check your email or run 'eas build:list' to see status."
