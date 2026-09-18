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
    // Increase the body size limit for API routes from the default 4.5 MB
    // to 50 MB. This allows syncing/uploading large notes and PDFs.
    // Vercel Hobby's default is 4.5 MB — without this override, syncing
    // a large note or uploading a big PDF fails with a body size error.
    serverActions: {
      bodySizeLimit: '50mb',
    },
  },
}

module.exports = nextConfig
