/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV === "development";

function getConfiguredFrameAncestors(value, { allowHttp }) {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      let url;
      try {
        url = new URL(origin);
      } catch {
        throw new Error(
          `Invalid ALLOWED_VISUALIZATION_ORIGIN value: ${origin}`
        );
      }

      const allowedProtocols = allowHttp ? ["http:", "https:"] : ["https:"];
      if (
        !allowedProtocols.includes(url.protocol) ||
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.hostname.includes("*") ||
        origin.includes(";")
      ) {
        throw new Error(
          `ALLOWED_VISUALIZATION_ORIGIN must contain exact ${
            allowHttp ? "HTTP or HTTPS" : "HTTPS"
          } origins: ${origin}`
        );
      }

      return url.origin;
    });
}

const CONFIGURED_FRAME_ANCESTORS = getConfiguredFrameAncestors(
  process.env.ALLOWED_VISUALIZATION_ORIGIN,
  { allowHttp: isDev }
);

// Dev fronts that may embed viz. dust-hive envs run on other ports and list them in
// ALLOWED_VISUALIZATION_ORIGIN (the same variable the content page checks), so include those too.
const DEV_FRAME_ANCESTORS = [
  "http://localhost:3000",
  "http://localhost:3011",
  "http://localhost:3012",
  "chrome-extension://okjldflokifdjecnhbmkdanjjbnmlihg",
  ...CONFIGURED_FRAME_ANCESTORS,
];

const PROD_FRAME_ANCESTORS = [
  "https://dust.tt",
  "https://app.dust.tt",
  "https://eu.dust.tt",
  "https://front-edge.dust.tt",
  "https://eu.front-edge.dust.tt",
  "https://*.preview.dust.tt",
  "chrome-extension://okjldflokifdjecnhbmkdanjjbnmlihg",
  "chrome-extension://fnkfcndbgingjcbdhaofkcnhcjpljhdn",
  ...CONFIGURED_FRAME_ANCESTORS,
];

const FRAME_ANCESTORS = [
  ...new Set(isDev ? DEV_FRAME_ANCESTORS : PROD_FRAME_ANCESTORS),
].join(" ");

const CONTENT_SECURITY_POLICIES = `connect-src 'self'; media-src 'self'; frame-ancestors 'self' https://app.frontapp.com ${FRAME_ANCESTORS} moz-extension:;`;

const nextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Access-Control-Allow-Origin",
            value: isDev ? "http://localhost:3000" : "https://dust.tt",
          },
          {
            key: "Content-Security-Policy",
            value: CONTENT_SECURITY_POLICIES,
          },
        ],
      },
      // Allow CORS for static files.
      {
        source: "/_next/static/:path*",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
      },
    ];
  },
};

export default nextConfig;
