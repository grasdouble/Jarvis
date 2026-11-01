export type QuotaField = "requestLimit" | "requestRemaining" | "tokenLimit" | "tokenRemaining";
export type QuotaCoverage = "reported" | "unknown" | "not_supported";
export type QuotaSignals = Readonly<{
  mappingVersion: string;
  source: "provider-response-header";
  provider: string;
  observedAt: string;
  freshness: "current" | "stale" | "unknown";
  counters: Readonly<Record<QuotaField, number | null>>;
  coverage: Readonly<Record<QuotaField, QuotaCoverage>>;
}>;
