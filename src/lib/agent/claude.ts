import Anthropic from "@anthropic-ai/sdk";

/**
 * Claude client for Polty.
 *
 * Preferred: Neon AI Gateway's Anthropic Messages endpoint — same official SDK, base URL
 * `${NEON_AI_GATEWAY_BASE_URL}/anthropic` (the SDK appends /v1/messages) and the gateway token as
 * a Bearer auth token; the gateway swaps in workspace credentials before forwarding to Anthropic.
 * Fallback: the default Anthropic credential resolution (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
 * or an `ant auth login` profile).
 */
export function createClaudeClient(): { client: Anthropic; provider: "anthropic" | "neon-ai-gateway" } {
  const base = process.env.NEON_AI_GATEWAY_BASE_URL || process.env.NEON_AI_GATEWAY_URL;
  const token = process.env.NEON_AI_GATEWAY_TOKEN || process.env.NEON_AI_GATEWAY_KEY;
  if (base && token) {
    const root = base.replace(/\/+$/, "").replace(/\/v1$/, "");
    return {
      provider: "neon-ai-gateway",
      client: new Anthropic({
        authToken: token,
        apiKey: null,
        baseURL: root.endsWith("/anthropic") ? root : `${root}/anthropic`,
      }),
    };
  }
  return { provider: "anthropic", client: new Anthropic() };
}
