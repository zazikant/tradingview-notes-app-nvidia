/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  // The `openai` SDK pulls in node-only modules that break the Next.js bundler.
  // Marking it as a serverComponentsExternalPackage lets Next defer it to the
  // Node runtime instead of bundling it for the Edge.
  experimental: {
    serverComponentsExternalPackages: ['openai'],
  },
}

module.exports = nextConfig
