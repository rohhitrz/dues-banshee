import type { Metadata } from "next";
import { Fraunces, IM_Fell_English, IM_Fell_English_SC, Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import "./globals.css";

const fraunces = Fraunces({ subsets: ["latin"], weight: "300", variable: "--font-fraunces", display: "swap" });
const imFell = IM_Fell_English({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-im-fell",
  display: "swap",
});
const imFellSc = IM_Fell_English_SC({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-im-fell-sc",
  display: "swap",
});
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono", display: "swap" });

const fontVariables = [fraunces, imFell, imFellSc, inter, jetbrainsMono].map((font) => font.variable).join(" ");

export const metadata: Metadata = {
  title: "Dues Banshee",
  description: "Chase unpaid invoices with Indian payment law on your side.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={fontVariables}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
