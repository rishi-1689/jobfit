import { useCallback, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import ResumeUploadCard from "../components/ResumeUploadCard";
import JobDescriptionForm from "../components/JobDescriptionForm";
import ApplicationsHistory from "../components/ApplicationsHistory";

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  // Bumping this forces <ApplicationsHistory> to re-fetch - simpler than
  // lifting the list into state here and having both forms reach into it.
  const [refreshToken, setRefreshToken] = useState(0);
  const refreshApplications = useCallback(() => setRefreshToken((n) => n + 1), []);

  async function handleSignOut() {
    await signOut();
    navigate("/login", { replace: true });
  }

  const displayName = user?.name ?? user?.email ?? "";
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-slate-50 to-violet-50">
      <header className="sticky top-0 z-10 bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-600 shadow-md">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/20 text-lg backdrop-blur-sm">
              🧭
            </span>
            <span className="font-semibold text-white">JobFit Copilot</span>
          </div>
          <div className="flex items-center gap-3 text-sm text-white/90">
            {user?.isAdmin && (
              <Link
                to="/admin"
                className="rounded-md bg-white/15 px-3 py-1 font-medium text-white hover:bg-white/25"
              >
                🛠️ Admin
              </Link>
            )}
            <span className="hidden items-center gap-2 sm:flex">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/25 text-xs font-semibold text-white">
                {initial}
              </span>
              {displayName}
            </span>
            <button
              onClick={handleSignOut}
              className="rounded-md border border-white/40 bg-white/10 px-3 py-1 font-medium text-white hover:bg-white/20"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-6 py-10">
        <ResumeUploadCard />
        <JobDescriptionForm onCreated={refreshApplications} />
        <ApplicationsHistory refreshToken={refreshToken} />
      </main>

      <footer className="py-6 text-center text-xs text-slate-400">
        jobfit made by rishi using AWS infrastructure
      </footer>
    </div>
  );
}
