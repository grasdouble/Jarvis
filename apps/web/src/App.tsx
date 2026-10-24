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
