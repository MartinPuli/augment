import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pair this phone — GHOST",
  description: "Lend your phone's camera, sensors and speaker to your personal agent — with a stop button.",
  robots: { index: false },
};

export default function JoinLayout({ children }: { children: React.ReactNode }) {
  return children;
}
