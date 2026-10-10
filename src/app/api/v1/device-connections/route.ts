import { coordinatorRequest } from "@/lib/ghost/server/vercel";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const GET = coordinatorRequest;
