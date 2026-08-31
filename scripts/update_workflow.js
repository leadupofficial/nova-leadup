const fs = require('fs');
const yaml = fs.readFileSync('.github/workflows/build-apk.yml', 'utf8');
const sedReplace = "sed -i.bak 's/kotlinVersion = .*/kotlinVersion = '2.2.21'/' build.gradle\\n\\n sed -i.bak '/expo-dev-launcher/d' app/build.gradle\\n\\n sed -i.bak '/expo-dev-launcher/d' settings.gradle\\n\\n echo 'Applied post-prebuild fixes'";
const nodeReplace = "node .github/workflows/fix-android.js\\n\\n echo 'Applied post-prebuild fixes'";
const newYaml = yaml.replace(sedReplace, nodeReplace);
fs.writeFileSync('.github/workflows/build-apk.yml', newYaml);
console.log('Done!');
