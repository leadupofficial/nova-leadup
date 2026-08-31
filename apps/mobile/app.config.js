module.exports = {
 expo: {
 name: 'NOVA',
 slug: 'nova',
 version: '0.1.0',
 orientation: 'portrait',
 userInterfaceStyle: 'automatic',
 splash: {
 image: './assets/splash.png',
 resizeMode: 'contain',
 backgroundColor: '#0F172A',
 },
 ios: {
 supportsTablet: true,
 bundleIdentifier: 'com.leadup.nova',
 },
 android: {
 package: 'com.leadup.nova',
 adaptiveIcon: {
 foregroundImage: './assets/adaptive-icon.png',
 backgroundColor: '#0F172A',
 },
 },
 plugins: [
 'expo-router',
 ],
 scheme: 'nova',
 extra: {
 eas: {
 projectId: 'eacfbae2-27cf-4dc4-b817-809bab3b5206',
 },
 },
 },
};
