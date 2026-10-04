/**
 * One place to construct the Anthropic client for GHOST (server-only).
 *
 * - Neon AI Gateway (optional): when NEON_AI_GATEWAY_BASE_URL + NEON_AI_GATEWAY_TOKEN are set,
 *   Claude calls go to the branch's Anthropic Messages endpoint
 *   `https://<branch-host>/anthropic` with `Authorization: Bearer <nt_live_... token>`
 *   (token scope `ai_gateway:invoke`). Usage is billed to Neon AI Gateway credits.
 *   Docs: https://neon.com/docs/ai-gateway/anthropic-messages
 * - Otherwise: `new Anthropic()` with the SDK's normal env resolution (ANTHROPIC_API_KEY, ...).
 *
 * Set GHOST_LLM_PROVIDER=anthropic to force the direct API even when the gateway is configured.
 * Same SDK and same request shapes either way (streaming, tools, prompt caching all pass through).
 */
import Anthropic from "@anthropic-ai/sdk";

export type LlmProvider = "neon-ai-gateway" | "anthropic";

/** Claude model ids the Neon AI Gateway lists for its Anthropic Messages endpoint (Oct 2026). */
export const NEON_GATEWAY_CLAUDE_MODELS = [
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4-1",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;

interface GatewayConfig {
  baseURL: string;
  token: string;
}

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

/** Resolve the Neon gateway config from env, or null if not configured / overridden. */
function neonGateway(): GatewayConfig | null {
  if (env("GHOST_LLM_PROVIDER") === "anthropic") return null;
  // NEON_AI_GATEWAY_URL / _KEY are accepted as aliases.
  const base = env("NEON_AI_GATEWAY_BASE_URL") ?? env("NEON_AI_GATEWAY_URL");
  const token = env("NEON_AI_GATEWAY_TOKEN") ?? env("NEON_AI_GATEWAY_KEY");
  if (!base || !token) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    console.warn("[llm] NEON_AI_GATEWAY_BASE_URL is not a valid URL; using the Anthropic API directly");
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) {
    console.warn("[llm] NEON_AI_GATEWAY_BASE_URL must be https; using the Anthropic API directly");
    return null;
  }
  // Accept the bare branch host (documented form) or a URL already ending in /anthropic.
  let baseURL = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  baseURL = baseURL.replace(/\/v1$/, "");
  if (!/\/anthropic$/.test(baseURL)) baseURL += "/anthropic";
  return { baseURL, token };
}

/** Which provider `createAnthropicClient()` will use right now (evaluated lazily from env). */
export const gatewayInfo: { readonly provider: LlmProvider; readonly baseURL: string } = {
  get provider(): LlmProvider {
    return neonGateway() ? "neon-ai-gateway" : "anthropic";
  },
  get baseURL(): string {
    return neonGateway()?.baseURL ?? env("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com";
  },
};

export function createAnthropicClient(opts: { timeout?: number; maxRetries?: number } = {}): Anthropic {
  const gw = neonGateway();
  if (gw) {
    return new Anthropic({
      baseURL: gw.baseURL,
      authToken: gw.token,
      // Never send ANTHROPIC_API_KEY (x-api-key) to the gateway: it authenticates with the Neon token.
      apiKey: null,
      ...opts,
    });
  }
  return new Anthropic({ ...opts });
}
