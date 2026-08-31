const fs = require('fs');
const path = require('path');

// When running from apps/mobile/android (via CI working-directory),
// __dirname is apps/mobile/android/.github/workflows
// So we need to go up: ../../.. to reach repo root
const androidDir = path.join(__dirname, '..', '..', '..');

// Fix build.gradle - remove the rootproject plugin and bump Kotlin
const buildGradle = path.join(androidDir, 'build.gradle');
if (fs.existsSync(buildGradle)) {
 let content = fs.readFileSync(buildGradle, 'utf8');
 content = content.replace(/apply plugin: "com\.facebook\.react\.rootproject"\n/g, '');
 fs.writeFileSync(buildGradle, content);
 console.log('Removed rootproject plugin from build.gradle');
}

// Remove expo-dev-launcher plugin references from app/build.gradle
const appGradle = path.join(androidDir, 'app', 'build.gradle');
if (fs.existsSync(appGradle)) {
 let content = fs.readFileSync(appGradle, 'utf8');
 const original = content;
 content = content.replace(/expo-dev-launcher[^\n]*\n?/g, '');
 if (content !== original) {
 fs.writeFileSync(appGradle, content);
 console.log('Removed expo-dev-launcher from app/build.gradle');
 }
}

// Remove expo-dev-launcher from settings.gradle
const settingsGradle = path.join(androidDir, 'settings.gradle');
if (fs.existsSync(settingsGradle)) {
 let content = fs.readFileSync(settingsGradle, 'utf8');
 const original = content;
 content = content.replace(/expo-dev-launcher[^\n]*\n?/g, '');
 if (content !== original) {
 fs.writeFileSync(settingsGradle, content);
 console.log('Removed expo-dev-launcher from settings.gradle');
 }
}

console.log('Done');
