<<<<<<< HEAD
/** @type {import('next').NextConfig} */
const config = {
 reactStrictMode: true,
 poweredByHeader: false,
 };

export default config;
=======
const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
 eslint: {
 ignoreDuringBuilds: true,
 },
 images: {
 remotePatterns: [],
 },
 webpack: (config) => {
 config.resolve.alias = {
 ...(config.resolve.alias || {}),
 '@': path.resolve(__dirname, './src'),
 };
 return config;
 },
};

module.exports = nextConfig;
>>>>>>> f0688da (feat: complete mobile app source files and add GitHub Actions APK build workflow)
