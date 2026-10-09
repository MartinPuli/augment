import https from "node:https";
import { lookup } from "node:dns/promises";
import { isPrivateIp } from "../partners/common";

export function httpsUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || raw.length > 2048)
    throw new Error("Expected an HTTPS URL without credentials or fragment");
  return url;
}

/** No redirects, cookies or credentials. Pin the checked DNS answer to prevent rebinding. */
export async function publicJson(raw: string): Promise<unknown> {
  const url = httpsUrl(raw);
  const signal = AbortSignal.timeout(8000);
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true, family: 4 }),
    new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("DNS timeout")), { once: true })),
  ]);
  if (!addresses.length || addresses.some(a => isPrivateIp(a.address))) throw new Error("Public IPv4 address required");
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      signal, family: 4,
      lookup: (_hostname, _options, callback) => callback(null, addresses[0].address, 4),
      headers: { accept: "application/json" },
    }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error("Metadata HTTP error")); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 65_536) request.destroy(new Error("Metadata too large"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("Invalid metadata JSON")); }
      });
    });
    request.on("error", reject);
  });
}
