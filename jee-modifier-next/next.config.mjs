// Build stamp shown in the sidebar, e.g. "v29-07-2026-06:10" (IST).
// Computed once per build, so every deploy gets a fresh version string.
const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
const pad = (n) => String(n).padStart(2, '0');
const buildVersion = `v${pad(ist.getUTCDate())}-${pad(ist.getUTCMonth() + 1)}-${ist.getUTCFullYear()}-${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}`;

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_VERSION: buildVersion,
  },
};

export default nextConfig;
