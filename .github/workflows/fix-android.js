const fs = require('fs');
const path = require('path');

const buildGradle = path.join(__dirname, '..', 'apps', 'mobile', 'android', 'build.gradle');
const appGradle = path.join(__dirname, '..', 'apps', 'mobile', 'android', 'app', 'build.gradle');
const settingsGradle = path.join(__dirname, '..', 'apps', 'mobile', 'android', 'settings.gradle');

// Fix build.gradle kotlin version
if (fs.existsSync(buildGradle)) {
 let content = fs.readFileSync(buildGradle, 'utf8');
 content = content.replace(/kotlinVersion = '1\.9\.25'/, "kotlinVersion = '2.0.21'");
 fs.writeFileSync(buildGradle, content);
 console.log('Fixed build.gradle');
}

// Remove expo-dev-launcher references
[appGradle, settingsGradle].forEach(file => {
 if (fs.existsSync(file)) {
 let content = fs.readFileSync(file, 'utf8');
 const original = content;
 content = content.replace(/.*expo-dev-launcher.*\n?/g, '');
 if (content !== original) {
 fs.writeFileSync(file, content);
 console.log('Removed expo-dev-launcher from ' + path.basename(file));
 }
 }
});

console.log('Done');
