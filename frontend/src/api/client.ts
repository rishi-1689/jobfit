import { fetchAuthSession } from "aws-amplify/auth";

const API_BASE = import.meta.env.VITE_API_ENDPOINT;

/**
 * Fetch wrapper that calls the JobFit Copilot API (see
 * infrastructure/cloudformation/api-stack.yaml) with the signed-in user's
 * Cognito **access token** as a bearer token.
 *
 * Access token, not ID token: an ID token says who the user is (for the
 * frontend to display); an access token authorizes calling an API on the
 * user's behalf - which is exactly what's happening here. API Gateway's
 * JWT authorizer validates it against the User Pool Client before the
 * request ever reaches a Lambda.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = await fetchAuthSession();
  const token = session.tokens?.accessToken?.toString();
  if (!token) {
    throw new Error("Not signed in");
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      message = JSON.parse(text).message ?? text;
    } catch {
      // response wasn't JSON; use the raw text
    }
    throw new Error(message || `${res.status} ${res.statusText}`);
  }

  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
