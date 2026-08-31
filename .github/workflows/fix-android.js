const fs = require('fs');
const path = require('path');

const androidDir = path.join(__dirname, '..', 'apps', 'mobile', 'android');

// Fix build.gradle - remove the rootproject plugin line and bump Kotlin
const buildGradle = path.join(androidDir, 'build.gradle');
if (fs.existsSync(buildGradle)) {
 let content = fs.readFileSync(buildGradle, 'utf8');
 // Remove the apply plugin line that causes com.android.library conflict
 content = content.replace(/apply plugin: "com\.facebook\.react\.rootproject"\n/g, '');
 // Update Kotlin version for Gradle 8.10.2 compat
 content = content.replace(/kotlinVersion = '1\.9\.25'/, "kotlinVersion = '1.9.22'");
 fs.writeFileSync(buildGradle, content);
 console.log('Fixed build.gradle');
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
