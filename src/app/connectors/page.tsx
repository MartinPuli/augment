import type { Metadata } from "next";
import Link from "next/link";
import ConnectorsGallery from "@/components/connectors/ConnectorsGallery";

export const metadata: Metadata = { title: "Connectors · GHOST" };

export default function ConnectorsPage() {
  return (
    <main className="min-h-dvh bg-[radial-gradient(1200px_600px_at_10%_-10%,rgb(45_212_191/0.16),transparent),radial-gradient(900px_500px_at_100%_0%,rgb(167_139_250/0.14),transparent)] bg-page px-4 py-8 sm:px-8 sm:py-12">
      <div className="mx-auto max-w-6xl">
        <Link href="/" className="ghost-chip inline-flex h-8 items-center rounded-full px-3 text-caption font-medium text-fg-2 hover:text-fg">
          ← Back to Polty
        </Link>
        <div className="mt-6">
          <ConnectorsGallery />
        </div>
      </div>
    </main>
  );
}
