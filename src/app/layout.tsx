import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { fontFaceCss } from "./fonts";

// Geist is the fallback for Maison Neue (body); Geist Mono is for codes and ids.
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "GHOST — Hardware for your agent",
  description: "Connect your agent to cameras, sensors and supported hardware through one MCP endpoint. Discover capabilities, request access and inspect real observations.",
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
        {children}
      </body>
    </html>
  );
}
