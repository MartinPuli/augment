import type { InternalAdapter } from "./types";

// STUB — replaced by the public-sources workstream.
export const caltransAdapter: InternalAdapter = {
  id: "caltrans",
  owner_id: "provider:caltrans",
  async invoke() {
    return { state: "failed", error: "caltrans adapter not implemented yet" };
  },
};
