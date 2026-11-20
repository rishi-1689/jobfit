import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "../context/AuthContext";

/**
 * Gate for authenticated-only routes. While the initial session check is
 * running we render nothing meaningful; once it resolves, unauthenticated
 * users are bounced to /login (remembering where they were headed).
 */
export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  // The page can land here mid-way through a Google redirect: Amplify is
  // still exchanging the ?code=... in the URL for tokens (see the Hub
  // listener in AuthContext), so `loading` may already be false with
  // `user` still null. Without this check we'd bounce to /login and then
  // immediately bounce back once the exchange finishes - keep showing
  // "loading" instead until that settles.
  const oauthRedirectInFlight =
    location.search.includes("code=") || location.search.includes("error=");

  if (loading || (oauthRedirectInFlight && !user)) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-500">
        Loading&hellip;
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}
