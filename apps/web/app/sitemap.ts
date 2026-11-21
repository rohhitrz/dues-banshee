import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo/site";

// One public page worth indexing. `/signin` is crawlable (see robots.ts) but not listed.
// Not in the proxy matcher: sitemap.xml must answer 200 signed out.
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${SITE_URL}/landing`, changeFrequency: "weekly", priority: 1 }];
}
