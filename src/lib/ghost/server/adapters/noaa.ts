import type { InternalAdapter } from "./types";

// STUB — replaced by the public-sources workstream.
export const noaaAdapter: InternalAdapter = {
  id: "noaa",
  owner_id: "provider:noaa",
  async invoke() {
    return { state: "failed", error: "noaa adapter not implemented yet" };
  },
};
