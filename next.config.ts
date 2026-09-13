import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Turbopack fetches next/font/google over its own Rust HTTP client, which
    // trusts only its bundled root certificates and ignores NODE_EXTRA_CA_CERTS.
    // Local TLS-inspecting antivirus re-signs the connection with a private CA,
    // so the font requests fail the build. Reading the OS trust store instead
    // picks up that CA the same way Node and curl already do.
    turbopackUseSystemTlsCerts: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'amethyst-implicit-silkworm-944.mypinata.cloud',
        pathname: '**',
      },
    ],
  },
};

export default nextConfig;
