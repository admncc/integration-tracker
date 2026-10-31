/** Thin fetch wrapper: cookies always ride along, errors surface as thrown `Error`s. */
export class ApiError extends Error {
  status: number;
  /** The body the server sent; a 409 carries the current state of the record. */
  payload: Record<string, unknown>;

  constructor(message: string, status: number, payload: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

/**
 * A request that never comes back is worse than one that fails: the optimistic
 * cell keeps the typed value and nothing ever says it was not saved. Thirty
 * seconds is well beyond any real response here.
 */
const TIMEOUT_MS = 30_000;

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      signal: abort.signal,
      ...options,
    });
  } catch (err) {
    // "Failed to fetch" is the browser's wording for offline, a dead server and
    // a DNS failure alike, and it tells the reader nothing about what to do.
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('The server did not answer within 30 seconds. Nothing was saved - try again.', 0);
    }
    throw new ApiError('No connection to the server. Check your network and try again - nothing was saved.', 0);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new ApiError(
      (payload as { error?: string }).error ?? `Request failed (${response.status})`,
      response.status,
      payload as Record<string, unknown>
    );
    // A session that expired mid-visit should return to the sign-in form, not
    // leave every page rendering its own "Not signed in".
    if (response.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new CustomEvent('tracker:signed-out'));
    }
    throw error;
  }
  return payload as T;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: <T,>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T,>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T,>(path: string) => request<T>(path, { method: 'DELETE' }),
};
