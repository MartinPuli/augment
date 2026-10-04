import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Unbounded } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const unbounded = Unbounded({ variable: "--font-unbounded", subsets: ["latin"], weight: ["400", "600", "800"] });

export const metadata: Metadata = {
  title: "GHOST — give your agent a body",
  description:
    "An open-source network for personal agents to borrow physical capabilities: cameras, sensors, lights, robots and instruments.",
};

export const viewport: Viewport = {
  themeColor: "#0a0b0e",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${unbounded.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
