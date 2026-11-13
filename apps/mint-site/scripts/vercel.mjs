// vercel.json for a site config: the static output folder and the security headers, with a Content-Security-Policy
// that allows exactly what the config needs (lib/config.js cspFor). scripts/csp.mjs writes it; scripts/check.mjs
// compares it with the committed file; scripts/dev-server.mjs sends the same headers.
import { cspFor } from "../web/lib/config.js";

export function vercelConfig(site) {
  return {
    $schema: "https://openapi.vercel.sh/vercel.json",
    framework: null,          // "Other", as forge.litvm.games: no build script, Vercel serves web/ as it is
    installCommand: "",       // skip the install: the only dependency is the tests' ethers (Vercel docs: "An empty string value will cause the Install Command to be skipped")
    outputDirectory: "web",
    headers: [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: cspFor(site) },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
      { source: "/site.config.json", headers: [{ key: "Cache-Control", value: "no-cache" }] },
    ],
  };
}
