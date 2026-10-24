import type { ReactElement } from "react";

export interface DashboardRequestView {
  readonly id: string;
  readonly mode: string | null;
  readonly state: string;
  readonly attemptCount: number | null;
  readonly attempts?: readonly { readonly ordinal: number; readonly state: string; readonly observedAt: string | null }[];
  readonly remoteResult: string;
  readonly observedAt: string | null;
  readonly pullRequests: readonly DashboardPullRequestView[];
  readonly truncation?: { readonly attemptsOmitted?: number; readonly pullRequestsOmitted?: number };
}

export interface DashboardPullRequestView {
  readonly number: number;
  readonly state: string;
  readonly observedAt: string | null;
  readonly url?: string;
}

export interface DashboardProjectView {
  readonly id: string;
  readonly repository: string;
  readonly state: string;
  readonly configVersion: number | null;
  readonly health: string;
  readonly usage: Readonly<Record<string, unknown>> | null;
  readonly observedAt: string | null;
  readonly requests: readonly DashboardRequestView[];
  readonly pullRequests: readonly DashboardPullRequestView[];
  readonly truncation?: { readonly requestsOmitted?: number; readonly pullRequestsOmitted?: number };
}

export interface DashboardDataView {
  readonly provenance: { readonly source: string; readonly generatedAt: string };
  readonly projects: readonly DashboardProjectView[];
  readonly truncation?: { readonly projectsOmitted?: number };
}
export type DashboardView = DashboardDataView | { readonly error: string };

function canonicalPullRequestUrl(repository: string, pullRequest: DashboardPullRequestView): string | null {
  if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number < 1 || repository.length > 201) return null;
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length < 1 || part.length > 100
    || part === "." || part === ".." || !/^[A-Za-z0-9_.-]+$/.test(part))) return null;
  const [owner, name] = parts;
  const expected = `https://github.com/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/pull/${pullRequest.number}`;
  return pullRequest.url === expected ? expected : null;
}

function PullRequestLink(props: { readonly repository: string; readonly pullRequest: DashboardPullRequestView }): ReactElement {
  const href = canonicalPullRequestUrl(props.repository, props.pullRequest);
  return <>{href === null ? `#${props.pullRequest.number}` : <a href={href}>#{props.pullRequest.number}</a>}</>;
}

export function DashboardPanel(props: {
  readonly dashboard: DashboardView | null;
  readonly onExport: (format: "json" | "txt") => void;
}): ReactElement {
  const { dashboard } = props;
  return (
    <section aria-labelledby="operations-heading">
      <h2 id="operations-heading">Operational dashboard</h2>
      <p>Read-only persisted observations. Missing, stale, and unknown values remain explicit.</p>
      {dashboard === null ? <p role="status">Loading operational data…</p> : "error" in dashboard
        ? <p role="status">Operational data is unavailable.</p>
        : <>
          <p>Source: {dashboard.provenance.source}. Snapshot generated: {dashboard.provenance.generatedAt}</p>
          {dashboard.truncation?.projectsOmitted ? <p role="status">Bounded dashboard omitted {dashboard.truncation.projectsOmitted} authorized project(s).</p> : null}
          {dashboard.projects.length === 0 ? <p>No authorized projects are available.</p> : dashboard.projects.map((project) => (
            <article key={project.id}>
              <h3>{project.repository}</h3>
              <dl>
                <dt>Project status</dt><dd>{project.state}</dd>
                <dt>Configuration version</dt><dd>{project.configVersion ?? "Unknown"}</dd>
                <dt>Health</dt><dd>{project.health === "unknown" ? "Unknown" : project.health}</dd>
                <dt>Usage</dt><dd>{project.usage === null ? "Not available" : <>
                  <p>Persisted model requests: {String(project.usage.modelRequestCount ?? "Unknown")}{project.usage.modelRequestsTruncated ? ` (first 100 shown; ${String(project.usage.modelRequestsOmitted ?? "unknown number of")} omitted)` : ""}</p>
                  <p>Allocation limits: unknown; no ceiling decision or enforcement is implied.</p>
                  {Array.isArray(project.usage.modelRequests) && project.usage.modelRequests.map((value, index) => {
                    const modelRequest = value as Record<string, unknown>;
                    const ledger = modelRequest.ledger !== null && typeof modelRequest.ledger === "object"
                      ? modelRequest.ledger as Record<string, unknown> : null;
                    const observations = Array.isArray(modelRequest.observations) ? modelRequest.observations : [];
                    return <div key={String(modelRequest.id ?? index)}>
                      <p>Model request {String(modelRequest.id ?? "unknown")}: {String(modelRequest.state ?? "unknown")}; dispatched {String(modelRequest.dispatchedAt ?? "unknown")}</p>
                      <p>Provider/model: {String(modelRequest.provider ?? "unknown")}/{String(modelRequest.model ?? "unknown")}</p>
                      <p>Purpose: {String(modelRequest.purpose ?? "unknown")}</p>
                      <p>Request: {String(modelRequest.requestId ?? "unknown")}; Task: {String(modelRequest.taskId ?? "unknown")}; Attempt: {String(modelRequest.attemptId ?? "unknown")}</p>
                      {ledger === null ? <p>Ledger: unknown / not recorded.</p> : <>
                        <p>Token metrics: {JSON.stringify(ledger.tokenCounts ?? {})}; field status: {JSON.stringify(ledger.fieldStatuses ?? {})}</p>
                        <p>Reserved: {String(ledger.reserved ?? "unknown")}; estimated charge: {String(ledger.estimatedCharge ?? "unknown")}; provider-reported charge: {String(ledger.providerReportedCharge ?? "unknown")}; stored currency: {String(ledger.currency ?? "unknown")}; reconciliation: {String(ledger.reconciliationState ?? "unknown")}</p>
                      </>}
                      {observations.map((observationValue, observationIndex) => {
                        const observation = observationValue as Record<string, unknown>;
                        return <p key={observationIndex}>Observation: {String(observation.source ?? "unknown")}, coverage {String(observation.coverage ?? "unknown")}, mapping {String(observation.mappingVersion ?? "unknown")}, observed {String(observation.observedAt ?? "unknown")}; metrics {JSON.stringify(observation.numericUsage ?? {})}</p>;
                      })}
                      {typeof modelRequest.observationsOmitted === "number" && modelRequest.observationsOmitted > 0
                        ? <p role="status">Bounded view omitted {modelRequest.observationsOmitted} usage observation(s).</p> : null}
                    </div>;
                  })}
                </>}</dd>
                <dt>Freshness</dt><dd>{project.observedAt ? `Last persisted observation: ${project.observedAt}; freshness threshold not configured` : "Unknown / not observed"}</dd>
              </dl>
              {project.truncation?.requestsOmitted ? <p role="status">Bounded view omitted {project.truncation.requestsOmitted} request(s).</p> : null}
              {project.truncation?.pullRequestsOmitted ? <p role="status">Bounded view omitted {project.truncation.pullRequestsOmitted} project pull request(s).</p> : null}
              <h4>Requests</h4>
              {project.requests.length === 0 ? <p>No persisted requests.</p> : <ul>{project.requests.map((request) => (
                <li key={request.id}>
                  {request.mode ?? "Unknown mode"} · {request.state} · attempts: {request.attemptCount ?? "Unknown"} · remote result: {request.remoteResult} · observed: {request.observedAt ?? "Unknown"}
                  {request.attempts?.map((attempt) => <span key={attempt.ordinal}> · Attempt {attempt.ordinal}: {attempt.state}, observed {attempt.observedAt ?? "unknown"}</span>)}
                  {request.pullRequests.map((pr) => <span key={pr.number}> · PR <PullRequestLink repository={project.repository} pullRequest={pr} />: {pr.state}, observed {pr.observedAt ?? "unknown"}</span>)}
                  {request.truncation?.attemptsOmitted ? ` · ${request.truncation.attemptsOmitted} attempt(s) omitted` : ""}
                  {request.truncation?.pullRequestsOmitted ? ` · ${request.truncation.pullRequestsOmitted} pull request(s) omitted` : ""}
                </li>
              ))}</ul>}
              <h4>Pull requests</h4>
              {project.pullRequests.length === 0 ? <p>Not available / none observed.</p> : <ul>{project.pullRequests.map((pr) =>
                <li key={pr.number}><PullRequestLink repository={project.repository} pullRequest={pr} />: {pr.state}; observed {pr.observedAt ?? "unknown"}</li>,
              )}</ul>}
            </article>
          ))}
        </>}
      <button type="button" onClick={() => props.onExport("json")}>Download redacted JSON</button>
      <button type="button" onClick={() => props.onExport("txt")}>Download redacted text</button>
    </section>
  );
}
