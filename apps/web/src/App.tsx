import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import { DashboardPanel, type DashboardView } from "./DashboardPanel.js";

interface SessionView {
  readonly authenticated: boolean;
  readonly onboardingAvailable?: boolean;
  readonly ownerId?: string;
  readonly csrfToken: string;
}

const SESSION_PATH = "/api/v1/session";
const DASHBOARD_PATH = "/api/v1/dashboard";
const STOP_PATH = "/api/v1/stop";

interface StopControl { readonly stopped: boolean; readonly version: number }
interface StopView { readonly global: StopControl; readonly projects: Readonly<Record<string, StopControl>> }

async function readResponse(response: Response): Promise<SessionView | { readonly error?: string }> {
  try {
    return await response.json() as SessionView | { readonly error?: string };
  } catch {
    return {};
  }
}

export function App(): ReactElement {
  const [session, setSession] = useState<SessionView | null>(null);
  const [password, setPassword] = useState("");
  const [onboardingSecret, setOnboardingSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const initialSessionRequest = useRef<Promise<SessionView> | null>(null);
  const [dashboard, setDashboard] = useState<DashboardView | null>(null);
  const [stop, setStop] = useState<StopView | null>(null);

  async function fetchSession(): Promise<SessionView> {
    const response = await fetch(SESSION_PATH, { credentials: "same-origin", cache: "no-store" });
    const body = await readResponse(response);
    if (!response.ok || !("csrfToken" in body) || typeof body.csrfToken !== "string") {
      throw new Error("Authentication service is unavailable.");
    }
    return body as SessionView;
  }

  async function refreshSession(): Promise<void> {
    setSession(await fetchSession());
  }

  useEffect(() => {
    let active = true;
    initialSessionRequest.current ??= fetchSession();
    void initialSessionRequest.current
      .then((body) => {
        if (active) setSession(body);
      })
      .catch(() => {
        if (active) setError("Authentication service is unavailable.");
      });
    return (): void => {
      active = false;
    };
  }, []);

  async function submitCredentials(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (session === null) return;
    setBusy(true);
    setError(null);
    const onboarding = session.authenticated === false && session.onboardingAvailable === true;
    const path = onboarding ? `${SESSION_PATH}/onboard` : SESSION_PATH;
    const body = onboarding ? { secret: onboardingSecret, password } : { password };
    try {
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify(body),
      });
      const result = await readResponse(response);
      setPassword("");
      setOnboardingSecret("");
      if (!response.ok || !("csrfToken" in result) || typeof result.csrfToken !== "string"
        || !("ownerId" in result) || typeof result.ownerId !== "string") {
        setError(response.status === 401
          ? "The password was not accepted."
          : response.status === 429
            ? "Too many attempts. Wait before trying again."
            : response.status === 403
              ? "Onboarding is unavailable or the one-time secret was not accepted."
              : "The request could not be completed.");
        await refreshSession();
        return;
      }
      setSession({ authenticated: true, ownerId: result.ownerId, csrfToken: result.csrfToken });
    } catch {
      setPassword("");
      setOnboardingSecret("");
      setError("Authentication service is unavailable.");
    } finally {
      setBusy(false);
    }
  }

  async function logout(): Promise<void> {
    if (session === null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${SESSION_PATH}/logout`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "x-csrf-token": session.csrfToken },
      });
      if (!response.ok) throw new Error("logout rejected");
      await refreshSession();
    } catch {
      setError("Sign out could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!session?.authenticated) { setDashboard(null); return; }
    let active = true;
    void fetch(DASHBOARD_PATH, { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Dashboard unavailable");
        return response.json() as Promise<DashboardView>;
      })
      .then((value) => { if (active) setDashboard(value); })
      .catch(() => { if (active) setDashboard({ error: "Operational data is unavailable." }); });
    return (): void => { active = false; };
  }, [session?.authenticated]);

  useEffect(() => {
    if (!session?.authenticated) { setStop(null); return; }
    let active = true;
    void Promise.all([
      fetch(STOP_PATH, { credentials: "same-origin", cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error(); return response.json() as Promise<{ global: StopControl }>; }),
      fetch(DASHBOARD_PATH, { credentials: "same-origin", cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error(); return response.json() as Promise<DashboardView>; }),
    ]).then(async ([globalView, dashboardView]): Promise<void> => {
      if ("error" in dashboardView) throw new Error();
      const entries = await Promise.all(dashboardView.projects.map(async (project) => {
        const response = await fetch(`${STOP_PATH}/projects/${encodeURIComponent(project.id)}`, { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) throw new Error();
        const state = await response.json() as { project: StopControl | null };
        return [project.id, state.project ?? { stopped: false, version: 0 }] as const;
      }));
      if (active) setStop({ global: globalView.global, projects: Object.fromEntries(entries) });
    })
      .catch(() => { if (active) setStop(null); });
    return (): void => { active = false; };
  }, [session?.authenticated]);

  async function changeStop(projectId: string | undefined, current: { stopped: boolean; version: number }): Promise<void> {
    if (!session?.authenticated) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(projectId ? `${STOP_PATH}/projects/${encodeURIComponent(projectId)}` : STOP_PATH, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify({ stopped: !current.stopped, expectedVersion: current.version }),
      });
      if (response.status === 409) throw new Error("Stop state changed in another session; refresh and try again.");
      if (!response.ok) throw new Error("Stop control could not be updated.");
      const latest = await response.json() as { global?: StopControl; project?: StopControl | null };
      if (projectId === undefined) setStop((previous) => previous && latest.global ? { ...previous, global: latest.global } : null);
      else setStop((previous) => previous && latest.project ? { ...previous, projects: { ...previous.projects, [projectId]: latest.project } } : null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Stop control could not be updated."); }
    finally { setBusy(false); }
  }

  async function downloadExport(format: "json" | "txt"): Promise<void> {
    try {
      const response = await fetch(`${DASHBOARD_PATH}/export.${format}`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("Export unavailable");
      const blob = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `jarvis-dashboard.${format}`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch {
      setError("Dashboard export is unavailable.");
    }
  }

  if (session === null) {
    return <main aria-busy="true"><h1>JARVIS</h1><p role="status">Checking local owner session…</p>{error && <p role="alert">{error}</p>}</main>;
  }

  if (session.authenticated) {
    return (
      <main>
        <h1>JARVIS</h1>
        <p>Signed in as the local owner.</p>
        <DashboardPanel dashboard={dashboard} onExport={(format) => void downloadExport(format)} />
        <section aria-label="Emergency stop controls">
          <h2>Emergency stop</h2>
          {stop === null ? <p role="status">Stop state unavailable; execution remains fail-closed.</p> : <>
            <p>Global stop: {stop.global.stopped ? "Paused" : "Running"} (version {stop.global.version})</p>
            <button type="button" disabled={busy} onClick={() => void changeStop(undefined, stop.global)}>{stop.global.stopped ? "Resume all projects" : "Pause all projects"}</button>
            {dashboard && "projects" in dashboard && dashboard.projects.map((project) => {
              const value = stop.projects[project.id];
              return <div key={project.id}><p>{project.repository}: {value?.stopped ? "Paused" : "Running"} (version {value?.version ?? 0})</p>
                <button type="button" disabled={busy || value === undefined} onClick={() => value && void changeStop(project.id, value)}>{value?.stopped ? "Resume project" : "Pause project"}</button></div>;
            })}
          </>}
        </section>
        <button type="button" onClick={() => void logout()} disabled={busy}>Sign out</button>
        {error && <p role="alert">{error}</p>}
      </main>
    );
  }

  const onboarding = session.onboardingAvailable === true;
  return (
    <main>
      <h1>JARVIS</h1>
      <h2>{onboarding ? "Set up the local owner account" : "Sign in"}</h2>
      <form method="post" onSubmit={(event) => void submitCredentials(event)}>
        {onboarding && (
          <label>
            One-time onboarding secret
            <input
              name="onboarding-secret"
              type="password"
              autoComplete="off"
              required
              value={onboardingSecret}
              onChange={(event) => setOnboardingSecret(event.target.value)}
            />
          </label>
        )}
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete={onboarding ? "new-password" : "current-password"}
            minLength={onboarding ? 14 : undefined}
            maxLength={1024}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button type="submit" disabled={busy || password.length === 0 || (onboarding && onboardingSecret.length === 0)}>
          {busy ? "Please wait…" : onboarding ? "Create owner account" : "Sign in"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
