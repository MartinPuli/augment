/**
 * GHOST v0.1 HTTP API shapes that are not in contracts.ts (coordinator-specific responses).
 * Pure types: safe to import from browser, coordinator and scripts.
 */
import type {
  CapabilityRef,
  ConnectorKind,
  Device,
  Experience,
  Lease,
  PaymentReceipt,
  Terms,
} from "../contracts";

export const DEV_LEDGER_LABEL = "Development ledger — test funds, not a real payment";

export type PairingStatus = "invited" | "pending" | "confirmed" | "rejected" | "expired";

export interface PairingInfo {
  pairing_id: string;
  owner_id: string;
  code: string;
  status: PairingStatus;
  /** Set once a connector presented the code. */
  label: string | null;
  connector_kind: ConnectorKind | null;
  connector_id: string | null;
  created_at: string;
  expires_at: string;
}

export interface LedgerEntry {
  entry_id: string;
  principal_id: string;
  /** Signed integer cents: positive = credit, negative = debit. */
  amount_cents: number;
  currency: "USD";
  kind: "grant" | "lease_payment" | "lease_income" | "refund" | "compensation";
  lease_id: string | null;
  label: string;
  created_at: string;
}

export interface LedgerResponse {
  principal_id: string;
  balance_cents: number;
  currency: "USD";
  /** Always DEV_LEDGER_LABEL for the development ledger. */
  label: string;
  entries: LedgerEntry[];
}

export interface AcceptResponse {
  lease: Lease;
  payment: PaymentReceipt | null;
  balance_cents: number;
}

/** Lease plus display helpers for consoles. */
export interface LeaseView extends Lease {
  visitor_display_name?: string;
  owner_display_name?: string;
  devices?: { device_id: string; name: string }[];
}

export type TermsPatch = Partial<Pick<Terms, "price_cents" | "max_duration_s" | "requires_approval">> & {
  /** Positive integer, or null to make the quota unlimited. */
  quota?: number | null;
  /** Lowest negotiable price; null clears it (host never goes below price_cents). */
  floor_cents?: number | null;
  /** null clears the note. */
  note?: string | null;
};

export interface RecordExperienceRequest {
  goal: string;
  refs: CapabilityRef[];
  zone_id?: string;
  outcome: Experience["outcome"];
  cost_cents?: number;
  latency_ms?: number;
  failures?: string[];
  evidence?: string[];
  summary: string;
}

export interface ExperienceSearchResponse {
  experiences: (Experience & { score?: number })[];
  /** Sample size across all matches (so reliability always shows its denominator). */
  counts: { total: number; verified: number; unverified: number; failed: number };
}

export interface ConnectorInfo {
  connector_id: string;
  owner_id: string;
  label: string;
  connector_kind: ConnectorKind;
  online: boolean;
  last_seen: string | null;
  created_at: string;
}

export interface DevicesResponseItem extends Device {
  /** Active (reserved/payment_pending/active) lease ids touching this device. */
  active_lease_ids?: string[];
}
