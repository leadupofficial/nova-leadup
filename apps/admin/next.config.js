/** @type {import('next').NextConfig} */
const nextConfig = {
 reactStrictMode: true,
 // NOTE: do not enable `output: "standalone"` here. Its file tracing is
 // incomplete against pnpm's symlinked node_modules — the emitted
 // .next/standalone is missing next/dist/server/lib/cpu-profile and the server
 // dies on boot with "Cannot find module './cpu-profile'". The container runs
 // `next start` against a real install instead (see apps/admin/Dockerfile).
 outputFileTracingRoot: __dirname,
};

module.exports = nextConfig;
