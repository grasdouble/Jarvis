export interface GitHubAdapterOptions {
  /** Trusted live internal-project allowlist check; removals must be observed on every effect. */
  authorizeProjectRepository: (repository: string) => Promise<boolean>;
  /** Trusted, live installation check. Must fail closed if status cannot be established. */
  authorizeInstallationRepository: (repository: string) => Promise<boolean>;
  /** Trusted token port mints/provides a token constrained to this repository and operation permission. */
  token: (repository: string, permission: 'pull-requests:read' | 'pull-requests:write') => Promise<string>;
  fetch?: typeof globalThis.fetch;
  apiUrl?: string;
}

export interface PullRequestState { number: number; state: 'open' | 'closed'; headSha: string; baseSha: string; merged: boolean }
export interface PublicationIdentity { taskId: string; revision: string; repository: string; head: string; base: string; title: string }
export type PublicationResult =
  | { outcome: 'confirmed'; pullRequest: PullRequestState }
  | { outcome: 'rejected'; reason: 'forbidden' | 'invalid' | 'api-error' }
  | { outcome: 'unknown'; reason: 'not-found' | 'identity-mismatch' | 'reconciliation-failed' | 'incomplete-search' };

export interface GitHubAdapter {
  getPullRequest(repository: string, number: number): Promise<PullRequestState>;
  reconcilePublication(identity: PublicationIdentity): Promise<{ outcome: 'found'; pullRequest: PullRequestState } | { outcome: 'unknown'; reason: 'not-found' | 'identity-mismatch' }>;
  publishPullRequest(identity: PublicationIdentity): Promise<PublicationResult>;
}

class RepositoryAuthorizationError extends Error {}

export function createGitHubAdapter(options: GitHubAdapterOptions): GitHubAdapter {
  const request = options.fetch ?? globalThis.fetch;
  const apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');

  async function authorize(repository: string): Promise<void> {
    if (!(await options.authorizeProjectRepository(repository)) || !(await options.authorizeInstallationRepository(repository))) {
      throw new RepositoryAuthorizationError(`Repository ${repository} is not authorized by both the current JARVIS project allowlist and GitHub App installation`);
    }
  }

  async function call(repository: string, path: string, method = 'GET', body?: unknown): Promise<Response> {
    await authorize(repository);
    const permission = method === 'POST' ? 'pull-requests:write' : 'pull-requests:read';
    const token = await options.token(repository, permission);
    return request(`${apiUrl}${path}`, {
      method,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  function parsePull(raw: unknown): PullRequestState {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid pull request response');
    const pr = raw as Record<string, unknown>;
    const head = pr.head as Record<string, unknown> | undefined;
    const base = pr.base as Record<string, unknown> | undefined;
    if (!Number.isSafeInteger(pr.number) || (pr.state !== 'open' && pr.state !== 'closed') || typeof head?.sha !== 'string' || typeof base?.sha !== 'string' || typeof pr.merged !== 'boolean') throw new Error('Invalid pull request response');
    return { number: pr.number as number, state: pr.state, headSha: head.sha, baseSha: base.sha, merged: pr.merged };
  }

  function publicationMarker(identity: PublicationIdentity): string {
    return `JARVIS task ${identity.taskId} at revision ${identity.revision}`;
  }

  function matchesPublication(raw: unknown, identity: PublicationIdentity): boolean {
    if (!raw || typeof raw !== 'object') return false;
    const pr = raw as Record<string, unknown>;
    const head = pr.head as Record<string, unknown> | undefined;
    const base = pr.base as Record<string, unknown> | undefined;
    return pr.title === identity.title && pr.body === publicationMarker(identity) &&
      head?.ref === identity.head && head.sha === identity.revision &&
      (head.label === `${identity.repository.split('/')[0]}:${identity.head}` || head.label === identity.head) &&
      base?.ref === identity.base;
  }

  async function reconcile(identity: PublicationIdentity): Promise<{ outcome: 'found'; pullRequest: PullRequestState } | { outcome: 'unknown'; reason: 'not-found' | 'identity-mismatch' }> {
    const [owner] = identity.repository.split('/');
    const query = new URLSearchParams({ head: `${owner}:${identity.head}`, base: identity.base, state: 'all', per_page: '100' });
    const response = await call(identity.repository, `/repos/${identity.repository}/pulls?${query}`);
    if (!response.ok) throw new Error(`Reconciliation read failed (${response.status})`);
    const raw: unknown = await response.json();
    if (!Array.isArray(raw)) throw new Error('Invalid reconciliation response');
    const match = raw.find((item: unknown) => {
      if (!item || typeof item !== 'object') return false;
      const pr = item as Record<string, unknown>;
      const head = pr.head as Record<string, unknown> | undefined;
      const base = pr.base as Record<string, unknown> | undefined;
      return pr.title === identity.title && head?.ref === identity.head && base?.ref === identity.base;
    });
    if (match) {
      const number = (match as Record<string, unknown>).number;
      if (!Number.isSafeInteger(number)) throw new Error('Matching pull request has invalid number');
      const detailResponse = await call(identity.repository, `/repos/${identity.repository}/pulls/${number}`);
      if (!detailResponse.ok) throw new Error(`Reconciliation detail read failed (${detailResponse.status})`);
      const detail: unknown = await detailResponse.json();
      if (!matchesPublication(detail, identity)) return { outcome: 'unknown', reason: 'identity-mismatch' };
      return { outcome: 'found', pullRequest: parsePull(detail) };
    }
    if (response.headers.get('link')?.includes('rel="next"')) throw new Error('Reconciliation search is incomplete');
    return { outcome: 'unknown', reason: 'not-found' };
  }

  const adapter: GitHubAdapter = {
    async getPullRequest(repository: string, number: number): Promise<PullRequestState> {
      if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid pull request number');
      const response = await call(repository, `/repos/${repository}/pulls/${number}`);
      if (!response.ok) throw new Error(`GitHub API read failed (${response.status})`);
      return parsePull(await response.json());
    },
    async reconcilePublication(identity: PublicationIdentity): Promise<{ outcome: 'found'; pullRequest: PullRequestState } | { outcome: 'unknown'; reason: 'not-found' | 'identity-mismatch' }> { return reconcile(identity); },
    async publishPullRequest(identity: PublicationIdentity): Promise<PublicationResult> {
      if (!identity.taskId || !identity.revision || !identity.head || !identity.base || !identity.title || !/^[^/]+\/[^/]+$/.test(identity.repository)) return { outcome: 'rejected', reason: 'invalid' };
      let response: Response;
      try {
        response = await call(identity.repository, `/repos/${identity.repository}/pulls`, 'POST', { title: identity.title, head: identity.head, base: identity.base, body: publicationMarker(identity) });
      } catch (error) {
        if (error instanceof RepositoryAuthorizationError) throw error;
        return reconcileAfterUncertainty(identity);
      }
      if (response.status === 403 || response.status === 404) return { outcome: 'rejected', reason: 'forbidden' };
      if (response.status >= 400 && response.status < 500) return { outcome: 'rejected', reason: 'api-error' };
      if (!response.ok) return reconcileAfterUncertainty(identity);
      try {
        const raw = await response.json() as Record<string, unknown>;
        if (!matchesPublication(raw, identity)) return { outcome: 'unknown', reason: 'identity-mismatch' };
        return { outcome: 'confirmed', pullRequest: parsePull(raw) };
      }
      catch { return reconcileAfterUncertainty(identity); }
    },
  };
  return adapter;

  async function reconcileAfterUncertainty(identity: PublicationIdentity): Promise<PublicationResult> {
    try {
      const result = await reconcile(identity);
      return result.outcome === 'found' ? { outcome: 'confirmed', pullRequest: result.pullRequest } : result;
    } catch (error) {
      return { outcome: 'unknown', reason: error instanceof Error && error.message === 'Reconciliation search is incomplete' ? 'incomplete-search' : 'reconciliation-failed' };
    }
  }
}
