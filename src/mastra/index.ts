/**
 * GHOST missions on Mastra.
 *
 * Missions are deterministic multi-step physical procedures (Mastra Workflows) that a voice
 * agent can launch as one tool call. They have no LLM steps: every decision is code, every
 * device action goes through the coordinator API, and every step leaves evidence ids.
 *
 * Storage (needed so suspended missions survive restarts and so Studio shows runs/traces):
 * - MASTRA_STORAGE_URL=libsql://... or file:/abs/path.db  -> LibSQL at that URL
 * - else DATABASE_URL (e.g. Neon pooled Postgres)         -> PostgresStore, schema "mastra"
 * - else                                                   -> LibSQL file .ghost/mastra.db
 * Set GHOST_MISSIONS_STORAGE=memory to keep everything in memory (tests).
 *
 * Tracing: every mission run/step is traced to the storage above (Studio "Observability" tab)
 * and, when MASTRA_PLATFORM_ACCESS_TOKEN + MASTRA_PROJECT_ID are set, to Mastra Platform.
 * GHOST_MISSIONS_TRACING=0 disables tracing.
 *
 * Studio: `pnpm mastra:dev` (http://localhost:4111). See docs/partners-infra.md.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Mastra } from "@mastra/core/mastra";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { LibSQLStore } from "@mastra/libsql";
import { MastraPlatformExporter, MastraStorageExporter, Observability, SensitiveDataFilter } from "@mastra/observability";
import { PostgresStore } from "@mastra/pg";
import { inspectWithActuator } from "./workflows/inspect-with-actuator";
import { patrolCameras } from "./workflows/patrol-cameras";

export const missionWorkflows = {
  "inspect-with-actuator": inspectWithActuator,
  "patrol-cameras": patrolCameras,
} as const;

export type MissionName = keyof typeof missionWorkflows;

export function storageDescription(): string {
  if (process.env.GHOST_MISSIONS_STORAGE === "memory") return "memory";
  if (process.env.MASTRA_STORAGE_URL) return "libsql (MASTRA_STORAGE_URL)";
  if (process.env.DATABASE_URL) return "postgres (DATABASE_URL, schema mastra)";
  return "libsql (.ghost/mastra.db)";
}

function createStorage(): MastraCompositeStore | undefined {
  if (process.env.GHOST_MISSIONS_STORAGE === "memory") return undefined;
  if (process.env.MASTRA_STORAGE_URL) {
    return new LibSQLStore({ id: "ghost-missions", url: process.env.MASTRA_STORAGE_URL });
  }
  if (process.env.DATABASE_URL) {
    return new PostgresStore({ id: "ghost-missions", connectionString: process.env.DATABASE_URL, schemaName: "mastra", max: 4 });
  }
  const dir = path.resolve(process.env.GHOST_DATA_DIR ?? path.join(process.cwd(), ".ghost"));
  mkdirSync(dir, { recursive: true });
  return new LibSQLStore({ id: "ghost-missions", url: `file:${path.join(dir, "mastra.db")}` });
}

/** Hosted traces on Mastra Platform (projects.mastra.ai) when its credentials are present. */
const platformTracing = !!(process.env.MASTRA_PLATFORM_ACCESS_TOKEN && process.env.MASTRA_PROJECT_ID);

function createMastra(): Mastra {
  const storage = createStorage();
  const tracing = process.env.GHOST_MISSIONS_TRACING !== "0" && (!!storage || platformTracing);
  return new Mastra({
    workflows: { ...missionWorkflows },
    ...(storage ? { storage } : {}),
    ...(tracing
      ? {
          observability: new Observability({
            configs: {
              default: {
                serviceName: "ghost-missions",
                exporters: [
                  ...(storage ? [new MastraStorageExporter()] : []),
                  ...(platformTracing ? [new MastraPlatformExporter()] : []),
                ],
                // Redacts tokens/keys/passwords if they ever appear in step payloads.
                spanOutputProcessors: [new SensitiveDataFilter()],
              },
            },
          }),
        }
      : {}),
  });
}

// One instance per process, shared across duplicate module instances (tsx reloads, bundles).
const g = globalThis as unknown as { __ghostMastra?: Mastra };
export const mastra: Mastra = g.__ghostMastra ?? (g.__ghostMastra = createMastra());
