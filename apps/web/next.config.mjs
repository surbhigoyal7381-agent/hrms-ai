/** @type {import('next').NextConfig} */
const nextConfig = {
  // `packages/core` ships TypeScript source, not a build artefact — it is the
  // same repository, and a build step between the domain layer and the app
  // would buy nothing here. Next compiles it with the app.
  transpilePackages: ['@hrms/core'],

  // Telemetry is disabled in the Dockerfile and in CI, per
  // docs/06-technology-decisions.md §Telemetry kill list — those are the places
  // that actually run, and a switch set only on a developer's laptop protects
  // nobody. It is NOT set here, because a config file is not where the
  // deployment runs and this file would give false assurance.

  // A record view is not a public web page. Nothing here is indexed, embedded
  // or framed, and the defaults do not say so.
  poweredByHeader: false,

  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
      ],
    }];
  },
};

export default nextConfig;
