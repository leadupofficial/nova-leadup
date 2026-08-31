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
