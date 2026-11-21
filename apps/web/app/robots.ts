import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo/site";

// Only the two public pages are crawlable. `/api/` is listed on its own for readers of robots.txt;
// the bare `/` rule is default-deny, so the signed-in routes (`/`, `/import`, `/approvals`,
// `/graveyard`, `/debtor/*`, `/debtors/*`, `/call/*`) and any future route stay closed.
// Crawlers apply the longest matching rule, so the two Allow lines win over `/`.
// Not in the proxy matcher: robots.txt must answer 200 signed out.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/landing", "/signin"], disallow: ["/api/", "/"] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
