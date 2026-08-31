import yaml

data = {
 'name': 'Build Android APK',
 'on': {
 'push': {'branches': ['main', 'develop']},
 'pull_request': {'branches': ['main', 'develop']},
 'workflow_dispatch': None,
 },
 'jobs': {
 'build-apk': {
 'runs-on': 'ubuntu-latest',
 'env': {
 'EXPO_UNSTABLE_DISABLE_DEV_LAUNCHER_AUTOLINKING': '1',
 'EXPO_USE_COMMUNITY_AUTOLINKING': '1',
 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD': '1',
 },
 'steps': [
 {'uses': 'actions/checkout@v4'},
 {
 'name': 'Set up Node.js 22',
 'uses': 'actions/setup-node@v4',
 'with': {'node-version': '22.x'},
 },
 {'name': 'Install pnpm', 'uses': 'pnpm/action-setup@v4'},
 {'name': 'Install dependencies', 'run': 'pnpm install --no-frozen-lockfile'},
 {
 'name': 'Set up JDK 17',
 'uses': 'actions/setup-java@v4',
 'with': {'distribution': 'temurin', 'java-version': '17'},
 },
 {
 'name': 'Accept Android SDK licenses',
 'run': 'mkdir -p /usr/local/lib/android/sdk/licenses\n'
 'echo -e "\\nd243215ed4a640bd90b24baca47b2e39\\n\\n84831b9409646a918e30573bab4c9c91\\n\\nd56f5187479451eabf01fb78af6dfcb6" > /usr/local/lib/android/sdk/licenses/android-sdk-license\n'
 'echo -e "\\n84831b9409646a918e30573bab4c9c91\\n\\nd56f5187479451eabf01fb78af6dfcb6" > /usr/local/lib/android/sdk/licenses/android-sdk-preview-license\n'
 'echo "Accepted licenses"',
 },
 {'name': 'Set up Android SDK', 'uses': 'android-actions/setup-android@v3'},
 {
 'name': 'Create placeholder app assets',
 'working-directory': 'apps/mobile',
 'run': 'mkdir -p assets\n'
 'echo "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" | base64 -d > assets/icon.png\n'
 'cp assets/icon.png assets/adaptive-icon.png\n'
 'cp assets/icon.png assets/splash.png\n'
 'echo "Created valid placeholder assets"',
 },
 {
 'name': 'Fix Android build files',
 'working-directory': 'apps/mobile/android',
 'run': 'node .github/workflows/fix-android.js'
 },
 {
 'name': 'Build release APK',
 'working-directory': 'apps/mobile/android',
 'run': 'chmod +x gradlew\n./gradlew assembleRelease --no-daemon --warning-mode=none\necho "Built APK"',
 },
 {
 'name': 'Upload APK artifact',
 'uses': 'actions/upload-artifact@v4',
 'with': {
 'name': 'nova-android-apk',
 'path': 'apps/mobile/android/app/build/outputs/apk/release/*.apk',
 'retention-days': 30,
 'if-no-files-found': 'error',
 },
 },
 {
 'name': 'APK Info',
 'run': "find apps/mobile/android/app/build/outputs/apk/release -name '*.apk' -exec ls -lh {} \\; | awk '{print $5}'\necho 'APK built successfully!'"
 },
 ],
 },
 },
}

with open('.github/workflows/build-apk.yml', 'w') as f:
 yaml.dump(data, f, default_flow_style=False, sort_keys=False, allow_unicode=True)

# Fix YAML quirks
with open('.github/workflows/build-apk.yml') as f:
 content = f.read()
content = content.replace("'on':", "on:")
content = content.replace("workflow_dispatch: null", "workflow_dispatch:")
with open('.github/workflows/build-apk.yml', 'w') as f:
 f.write(content)

# Verify
with open('.github/workflows/build-apk.yml') as f:
 yaml.safe_load(f)
print('YAML valid!')
