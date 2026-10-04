import type { InternalAdapter } from "../types";

// STUB — replaced by the LAN / smart-home workstream.
export const lanAdapter: InternalAdapter = {
  id: "lan",
  owner_id: "provider:lan",
  async invoke() {
    return { state: "failed", error: "lan adapter not implemented yet" };
  },
};
