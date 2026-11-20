import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import {
  getAdminSettings,
  listAdminUsers,
  setApiKey,
  setUseLiveAI,
  setUserQuota,
  type AdminSettings,
  type AdminUser,
} from "../api/admin";

type Access = "checking" | "granted" | "denied";

export default function Admin() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const [access, setAccess] = useState<Access>("checking");
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [defaultQuota, setDefaultQuota] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [toggleBusy, setToggleBusy] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMessage, setKeyMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const [quotaInputs, setQuotaInputs] = useState<Record<string, string>>({});
  const [quotaBusyId, setQuotaBusyId] = useState<string | null>(null);
  const [quotaError, setQuotaError] = useState<Record<string, string>>({});

  const loadAll = useCallback(async () => {
    try {
      // Settings first: it's the cheap call that also tells us whether this
      // account is an admin at all. The real check is server-side (a 403
      // here means "not in the Admins group") - this page just reflects it.
      const s = await getAdminSettings();
      setSettings(s);
      setAccess("granted");

      const u = await listAdminUsers();
      setUsers(u.users);
      setDefaultQuota(u.defaultQuota);
      setQuotaInputs(
        Object.fromEntries(u.users.map((x) => [x.userId, String(x.effectiveQuota)])),
      );
      setLoadError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load";
      if (message === "Admins only") {
        setAccess("denied");
      } else {
        setAccess((prev) => (prev === "checking" ? "denied" : prev));
        setLoadError(message);
      }
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function handleToggle() {
    if (!settings) return;
    setToggleBusy(true);
    try {
      const res = await setUseLiveAI(!settings.useLiveAI);
      setSettings({ ...settings, useLiveAI: res.useLiveAI });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not update setting");
    } finally {
      setToggleBusy(false);
    }
  }

  async function handleSaveKey(e: FormEvent) {
    e.preventDefault();
    const key = apiKeyInput.trim();
    if (!key) return;
    setKeyBusy(true);
    setKeyMessage(null);
    try {
      await setApiKey(key);
      setApiKeyInput(""); // never keep the secret sitting in the form
      setSettings((s) => (s ? { ...s, apiKeyConfigured: true } : s));
      setKeyMessage({ ok: true, text: "Saved securely. The key isn't shown again." });
    } catch (err) {
      setKeyMessage({
        ok: false,
        text: err instanceof Error ? err.message : "Could not save key",
      });
    } finally {
      setKeyBusy(false);
    }
  }

  async function handleSaveQuota(u: AdminUser) {
    const quota = Number(quotaInputs[u.userId]);
    if (!Number.isInteger(quota) || quota < 0) {
      setQuotaError((p) => ({ ...p, [u.userId]: "Enter a whole number, 0 or more." }));
      return;
    }
    setQuotaBusyId(u.userId);
    setQuotaError((p) => ({ ...p, [u.userId]: "" }));
    try {
      const res = await setUserQuota(u.userId, quota);
      setUsers((prev) =>
        prev.map((x) =>
          x.userId === u.userId
            ? { ...x, applicationQuota: res.applicationQuota, effectiveQuota: res.applicationQuota }
            : x,
        ),
      );
    } catch (err) {
      setQuotaError((p) => ({
        ...p,
        [u.userId]: err instanceof Error ? err.message : "Could not save",
      }));
    } finally {
      setQuotaBusyId(null);
    }
  }

  async function handleSignOut() {
    await signOut();
    navigate("/login", { replace: true });
  }

  const displayName = user?.name ?? user?.email ?? "";

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-slate-50 to-violet-50">
      <header className="sticky top-0 z-10 bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-600 shadow-md">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/20 text-lg backdrop-blur-sm">
              🛠️
            </span>
            <span className="font-semibold text-white">JobFit Admin</span>
          </div>
          <div className="flex items-center gap-3 text-sm text-white/90">
            <Link to="/dashboard" className="hover:text-white">
              ← Dashboard
            </Link>
            <span className="hidden sm:inline">{displayName}</span>
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
        {access === "checking" && <p className="text-sm text-slate-500">Checking access…</p>}

        {access === "denied" && (
          <section className="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-900/5">
            <p className="text-3xl">🔒</p>
            <h1 className="mt-2 text-lg font-semibold text-slate-900">Admins only</h1>
            <p className="mt-1 text-sm text-slate-500">
              {loadError && loadError !== "Admins only"
                ? loadError
                : "This account isn't in the Admins group. If it should be, sign out and back in after being added."}
            </p>
          </section>
        )}

        {access === "granted" && settings && (
          <>
            {loadError && <p className="text-sm text-red-600">{loadError}</p>}

            {/* ---------------------------------------------------- AI */}
            <section className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-900/5">
              <div className="flex items-center gap-3 border-b border-slate-100 bg-gradient-to-r from-violet-50 to-indigo-50 px-6 py-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-base text-white shadow-sm">
                  🤖
                </span>
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">AI processing</h2>
                  <p className="text-sm text-slate-500">
                    One global switch for every user &mdash; no redeploy needed.
                  </p>
                </div>
              </div>

              <div className="space-y-6 p-6">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-slate-900">Use live AI model</p>
                    <p className="text-xs text-slate-500">
                      Off: deterministic keyword matching. On: the AI path, falling back to
                      keyword matching automatically if it fails.
                    </p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={settings.useLiveAI}
                    onClick={handleToggle}
                    disabled={toggleBusy}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50 ${
                      settings.useLiveAI ? "bg-violet-600" : "bg-slate-300"
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                        settings.useLiveAI ? "translate-x-5" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </div>

                {settings.useLiveAI && !settings.apiKeyConfigured && (
                  <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                    Live AI is on but no API key is saved yet &mdash; every application will
                    fall back to keyword matching until you add one below.
                  </p>
                )}
                <p className="rounded-md bg-slate-50 p-2 text-xs text-slate-500">
                  Heads up: the live AI call itself isn&rsquo;t implemented yet, so even with a key
                  saved, turning this on currently still ends in the keyword-matching fallback.
                </p>

                <form onSubmit={handleSaveKey} className="border-t border-slate-100 pt-6">
                  <div className="mb-2 flex items-center justify-between">
                    <label htmlFor="api-key" className="text-sm font-medium text-slate-900">
                      AI provider API key
                    </label>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                        settings.apiKeyConfigured
                          ? "bg-emerald-100 text-emerald-800 ring-emerald-600/20"
                          : "bg-amber-100 text-amber-800 ring-amber-600/20"
                      }`}
                    >
                      {settings.apiKeyConfigured ? "Configured" : "Not configured"}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <input
                      id="api-key"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      placeholder={settings.apiKeyConfigured ? "Paste a new key to replace it" : "Paste your API key"}
                      className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                    />
                    <button
                      type="submit"
                      disabled={keyBusy || !apiKeyInput.trim()}
                      className="rounded-md bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:from-violet-500 hover:to-indigo-500 disabled:opacity-50"
                    >
                      {keyBusy ? "Saving…" : "Save key"}
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    Write-only: stored encrypted (SSM SecureString) and never sent back to this
                    page, so you can&rsquo;t read it here again &mdash; only replace it.
                  </p>
                  {keyMessage && (
                    <p className={`mt-2 text-xs ${keyMessage.ok ? "text-emerald-600" : "text-red-600"}`}>
                      {keyMessage.text}
                    </p>
                  )}
                </form>
              </div>
            </section>

            {/* ------------------------------------------------ Quotas */}
            <section className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-900/5">
              <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-gradient-to-r from-amber-50 to-orange-50 px-6 py-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 text-base text-white shadow-sm">
                    📊
                  </span>
                  <div>
                    <h2 className="text-lg font-semibold text-slate-900">Users &amp; quotas</h2>
                    <p className="text-sm text-slate-500">
                      Job descriptions each user may submit
                      {defaultQuota !== null && <> &mdash; default is {defaultQuota}</>}.
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => void loadAll()}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Refresh
                </button>
              </div>

              <div className="p-6">
                {users.length === 0 && <p className="text-sm text-slate-500">No users yet.</p>}
                <ul className="divide-y divide-slate-100">
                  {users.map((u) => {
                    const pct =
                      u.effectiveQuota > 0
                        ? Math.min(100, Math.round((u.applicationCount / u.effectiveQuota) * 100))
                        : 100;
                    const atLimit = u.applicationCount >= u.effectiveQuota;
                    return (
                      <li key={u.userId} className="py-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-slate-900">
                              {u.name || u.email || u.userId}
                            </p>
                            {u.name && u.email && (
                              <p className="truncate text-xs text-slate-500">{u.email}</p>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={quotaInputs[u.userId] ?? ""}
                              onChange={(e) =>
                                setQuotaInputs((p) => ({ ...p, [u.userId]: e.target.value }))
                              }
                              className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                              aria-label={`Quota for ${u.email ?? u.userId}`}
                            />
                            <button
                              onClick={() => void handleSaveQuota(u)}
                              disabled={
                                quotaBusyId === u.userId ||
                                quotaInputs[u.userId] === String(u.effectiveQuota)
                              }
                              className="rounded-md bg-gradient-to-r from-amber-500 to-orange-600 px-3 py-1 text-xs font-medium text-white shadow-sm hover:from-amber-400 hover:to-orange-500 disabled:opacity-40"
                            >
                              {quotaBusyId === u.userId ? "Saving…" : "Save"}
                            </button>
                          </div>
                        </div>
                        <div className="mt-2 flex items-center gap-3">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className={`h-full rounded-full ${atLimit ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-emerald-500"}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="shrink-0 text-xs text-slate-500">
                            {u.applicationCount} / {u.effectiveQuota} used
                            {u.applicationQuota === null && " (default)"}
                          </span>
                        </div>
                        {quotaError[u.userId] && (
                          <p className="mt-1 text-xs text-red-600">{quotaError[u.userId]}</p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
