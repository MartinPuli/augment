/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed third-party JSON */
import { defineService, fetchCached, ok, reject, str, ui } from "./common";

/** CoinGecko public API (keyless, rate-limited). */

const ALIASES: Record<string, string> = { btc: "bitcoin", eth: "ethereum", sol: "solana", doge: "dogecoin", ada: "cardano", xrp: "ripple", ltc: "litecoin", dot: "polkadot", bnb: "binancecoin", usdt: "tether", usdc: "usd-coin", matic: "matic-network", avax: "avalanche-2" };

export const cryptoService = defineService({
  id: "crypto",
  name: "Crypto prices · CoinGecko",
  vendor: "CoinGecko",
  icon: "bitcoin",
  source: { operator: "CoinGecko", url: "https://www.coingecko.com", attribution: "Data provided by CoinGecko" },
  caps: [
    {
      capability_id: "crypto.price",
      title: "Cryptocurrency price",
      description: "Current USD price, 24 h change and market cap for a cryptocurrency by name or symbol (bitcoin, BTC, ETH, solana...).",
      input_schema: {
        type: "object",
        properties: { coin: { type: "string", description: "Coin name, CoinGecko id or ticker symbol." } },
        required: ["coin"],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const raw = str(args.coin, 60);
        if (!raw) return reject("coin is required");
        let id = ALIASES[raw.toLowerCase()] ?? raw.toLowerCase().replace(/\s+/g, "-");
        const priceUrl = (cid: string) =>
          `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(cid)}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_last_updated_at=true`;
        let { body, cached } = await fetchCached<Record<string, any>>(priceUrl(id), { signal: ctx.signal });
        if (!body[id]) {
          const { body: s } = await fetchCached<{ coins?: { id: string }[] }>(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(raw)}`, { signal: ctx.signal, ttl: 3600_000 });
          const found = s.coins?.[0]?.id;
          if (!found) return { state: "failed", error: `CoinGecko has no coin matching "${raw}"` };
          id = found;
          ({ body, cached } = await fetchCached<Record<string, any>>(priceUrl(id), { signal: ctx.signal }));
          if (!body[id]) return { state: "failed", error: `CoinGecko returned no price for ${id}` };
        }
        const p = body[id];
        const price = typeof p.usd === "number" ? p.usd : null;
        const change = typeof p.usd_24h_change === "number" ? Math.round(p.usd_24h_change * 100) / 100 : null;
        const captured_at = typeof p.last_updated_at === "number" ? new Date(p.last_updated_at * 1000).toISOString() : null;
        const url = `https://www.coingecko.com/en/coins/${id}`;
        return ok({
          kind: "value",
          value: price,
          unit: "USD",
          captured_at,
          source: { name: "CoinGecko", url, attribution: "Data provided by CoinGecko" },
          note: `${id}: $${price} (${change !== null ? `${change > 0 ? "+" : ""}${change}%` : "?"} 24 h).`,
          data: {
            coin: id,
            price_usd: price,
            change_24h_pct: change,
            market_cap_usd: p.usd_market_cap ?? null,
            cached,
            ui: ui("list", { items: [{ title: `${id} · $${price?.toLocaleString("en-US") ?? "?"}`, subtitle: `${change !== null ? `${change > 0 ? "+" : ""}${change}%` : "?"} in 24 h`, url }] }, `Crypto · ${id}`),
          },
        });
      },
    },
  ],
});
