import type { Metadata } from "next";
import Link from "next/link";
import ConnectorsGallery from "@/components/connectors/ConnectorsGallery";

export const metadata: Metadata = { title: "Connectors · GHOST" };

export default function ConnectorsPage() {
  return (
    <main className="min-h-dvh px-4 pb-16 pt-[max(24px,env(safe-area-inset-top))] sm:px-8 sm:pt-10">
      <div className="ghost-glass mx-auto max-w-6xl rounded-card px-4 py-6 sm:px-8 sm:py-8">
        <Link href="/" className="ghost-chip inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-caption font-medium text-fg-2 transition-colors hover:text-fg">
          <span aria-hidden>←</span> Back to Polty
        </Link>
        <div className="mt-6">
          <ConnectorsGallery />
        </div>
      </div>
    </main>
  );
}
