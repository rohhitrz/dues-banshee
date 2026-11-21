import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo/site";

// Default-deny: `Disallow: /` keeps the signed-in routes (`/import`, `/approvals`, `/graveyard`,
// `/debtor/*`, `/debtors/*`, `/call/*`) and any future route closed, and `/api/` is listed for readers.
// Crawlers apply the longest matching rule, so these Allow lines win over `/`:
//   /landing, /signin  the public pages
//   /$                 the bare home page (`$` anchors the end, so it does not open every path)
//   /_next/            CSS, JS and fonts, which crawlers need to render the pages
//   /icon, /apple-icon the generated icons (served as `/icon-<hash>`, `/apple-icon-<hash>`)
//   /favicon.ico       the legacy favicon path some crawlers request
// Not in the proxy matcher: robots.txt must answer 200 signed out.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/landing", "/signin", "/$", "/_next/", "/icon", "/apple-icon", "/favicon.ico"],
        disallow: ["/api/", "/"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
