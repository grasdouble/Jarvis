import type { PostgresStopControlStore } from "@jarvis/persistence";
import type { OwnerAuthBoundary } from "./auth.js";
import { createOperationalStopControlHandler, type StopControlWorkerPort } from "./stop-controls.js";
import { createOperationalDashboardServer, type DashboardHttpHandler } from "./http-server.js";

/** Local process composition only. Durable polling remains authoritative across processes. */
export function createRuntimeComposition(options: {
  readonly store: PostgresStopControlStore;
  readonly auth: OwnerAuthBoundary;
  readonly worker: StopControlWorkerPort;
  readonly dashboard: DashboardHttpHandler;
}): { readonly stopControls: ReturnType<typeof createOperationalStopControlHandler>; readonly server: ReturnType<typeof createOperationalDashboardServer> } {
  const stopControls = createOperationalStopControlHandler(options.store, options.auth, options.worker);
  return {
    stopControls,
    server: createOperationalDashboardServer({ dashboard: options.dashboard, auth: options.auth, stopControls }),
  };
}
