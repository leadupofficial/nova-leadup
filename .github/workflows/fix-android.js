const fs = require('fs');
const path = require('path');

const androidDir = path.join(__dirname, '..', 'apps', 'mobile', 'android');

// Fix build.gradle - remove the rootproject plugin and bump Kotlin
const buildGradle = path.join(androidDir, 'build.gradle');
if (fs.existsSync(buildGradle)) {
 let content = fs.readFileSync(buildGradle, 'utf8');
 content = content.replace(/apply plugin: "com\.facebook\.react\.rootproject"\n/g, '');
 content = content.replace(/kotlinVersion = '1\.9\.25'/, "kotlinVersion = '2.0.21'");
 fs.writeFileSync(buildGradle, content);
 console.log('Fixed build.gradle');
}

// Remove expo-dev-launcher plugin references
['app/build.gradle', 'settings.gradle'].forEach(relPath => {
 const file = path.join(androidDir, relPath);
 if (fs.existsSync(file)) {
 let content = fs.readFileSync(file, 'utf8');
 const original = content;
 content = content.replace(/expo-dev-launcher[^\n]*\n?/g, '');
 if (content !== original) {
 fs.writeFileSync(file, content);
 console.log('Removed expo-dev-launcher from ' + relPath);
 }
 }
});

// Pin Gradle wrapper to 8.10.2 to avoid Kotlin 2.2 compatibility issues
const gradleProps = path.join(androidDir, 'gradle', 'wrapper', 'gradle-wrapper.properties');
if (fs.existsSync(gradleProps)) {
 let content = fs.readFileSync(gradleProps, 'utf8');
 content = content.replace(
 /gradle-[\d.]+-all\.zip/,
 'gradle-8.10.2-all.zip'
 );
 fs.writeFileSync(gradleProps, content);
 console.log('Pinned Gradle to 8.10.2');
}

console.log('Done');
