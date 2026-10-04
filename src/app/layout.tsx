import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { fontFaceCss } from "./fonts";
import { NatureBackground } from "@/components/background/NatureBackground";

// Geist is the fallback for Maison Neue (body); Geist Mono is for codes and ids.
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "GHOST — Polty, your personal agent",
  description: "A personal agent that can also borrow real-world eyes and hands: cameras, sensors, lights, robots and instruments.",
};

export const viewport: Viewport = {
  themeColor: "#f4f3ef",
  colorScheme: "light",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        {/* Licensed faces from public/fonts (only files that exist); React hoists this into <head>. */}
        <style href="ghost-fonts" precedence="default">
          {fontFaceCss()}
        </style>
        <NatureBackground />
        {children}
      </body>
    </html>
  );
}
