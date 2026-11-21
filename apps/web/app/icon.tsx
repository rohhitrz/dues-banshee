import { ImageResponse } from "next/og";
import { GhostMark } from "@/lib/seo/ghost-mark";

// Static at build time. Not in the proxy matcher, so it answers 200 signed out.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(<GhostMark size={size.width} />, size);
}
