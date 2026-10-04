/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed third-party JSON */
import { defineService, fetchCached, ok, reject, str, ui } from "./common";

/** Wikipedia REST summary (keyless). Falls back to opensearch to resolve fuzzy topics. */

export const wikipediaService = defineService({
  id: "wikipedia",
  name: "Wikipedia",
  vendor: "Wikimedia",
  icon: "book-open",
  source: { operator: "Wikimedia Foundation", url: "https://en.wikipedia.org", attribution: "Wikipedia (CC BY-SA 4.0)", conditions_url: "https://foundation.wikimedia.org/wiki/Terms_of_Use" },
  caps: [
    {
      capability_id: "wikipedia.summary",
      title: "Wikipedia summary of a topic",
      description: "Short encyclopedic summary (lead paragraph, thumbnail, link) of any topic, person or place from English Wikipedia.",
      input_schema: {
        type: "object",
        properties: { topic: { type: "string", description: "Topic, e.g. 'Golden Gate Bridge'." } },
        required: ["topic"],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const topic = str(args.topic, 200);
        if (!topic) return reject("topic is required");
        // Resolve fuzzy input to a canonical title first.
        const search = `https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&namespace=0&format=json&search=${encodeURIComponent(topic)}`;
        const { body: os } = await fetchCached<[string, string[]]>(search, { signal: ctx.signal });
        const title = os?.[1]?.[0] ?? topic;
        const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`;
        const { body, cached } = await fetchCached<Record<string, any>>(url, { signal: ctx.signal });
        if (!body?.extract) return { state: "failed", error: `no Wikipedia article for "${topic}"` };
        const page = body.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`;
        const summary = {
          title: body.title as string,
          description: (body.description as string) ?? null,
          extract: String(body.extract).slice(0, 2000),
          url: page,
          thumbnail: body.thumbnail?.source ?? null,
          coordinates: body.coordinates ? { lat: body.coordinates.lat, lon: body.coordinates.lon } : null,
          last_edited: body.timestamp ?? null,
        };
        return ok({
          kind: "text",
          value: summary.extract,
          captured_at: summary.last_edited,
          source: { name: "Wikipedia", url: page, attribution: "Wikipedia (CC BY-SA 4.0)" },
          data: {
            ...summary,
            cached,
            ui: ui("list", { items: [{ title: summary.title, subtitle: summary.extract, url: page, image: summary.thumbnail }] }, summary.title),
          },
        });
      },
    },
  ],
});
