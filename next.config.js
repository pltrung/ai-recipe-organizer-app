/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["jsdom", "@mozilla/readability"],
  },
};

module.exports = nextConfig;
