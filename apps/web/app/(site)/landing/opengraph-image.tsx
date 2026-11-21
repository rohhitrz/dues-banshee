import { ImageResponse } from "next/og";
import { HERO } from "@/lib/landing/copy";

// Generated at build time: the image is the same for every visitor.
export const alt = "Dues Banshee: They forgot your invoice. The taxman won't.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// No external fonts or images: next/og renders with its bundled default font. Colours are the
// --sky, --bone, --spectral, --moonlight and --ember tokens from globals.css.
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 96px",
          backgroundImage: "linear-gradient(180deg, #1b1530 0%, #0c0a14 60%, #07080b 100%)",
          color: "#ece7db",
        }}
      >
        <div style={{ display: "flex", fontSize: 28, letterSpacing: 6, color: "#7ce8c0", textTransform: "uppercase" }}>
          Unpaid invoices, resurrected
        </div>
        <div style={{ display: "flex", fontSize: 112, marginTop: 24, lineHeight: 1.05 }}>Dues Banshee</div>
        <div style={{ display: "flex", fontSize: 48, marginTop: 32, lineHeight: 1.25, color: "#f3ebd3" }}>
          {HERO.title}
        </div>
        <div
          style={{
            display: "flex",
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 12,
            backgroundColor: "#ff8a3d",
          }}
        />
      </div>
    ),
    size,
  );
}
