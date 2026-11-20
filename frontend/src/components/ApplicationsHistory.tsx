import { useCallback, useEffect, useRef, useState } from "react";
import {
  listApplications,
  updateApplication,
  deleteApplication,
  type JobApplication,
} from "../api/applications";

const STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-600/20",
  PROCESSING: "bg-blue-100 text-blue-800 ring-1 ring-inset ring-blue-600/20",
  DONE: "bg-emerald-100 text-emerald-800 ring-1 ring-inset ring-emerald-600/20",
  FAILED: "bg-red-100 text-red-800 ring-1 ring-inset ring-red-600/20",
};

const STATUS_BORDER: Record<string, string> = {
  PENDING: "border-l-amber-400",
  PROCESSING: "border-l-blue-400",
  DONE: "border-l-emerald-400",
  FAILED: "border-l-red-400",
};

const STATUS_DOT: Record<string, string> = {
  PENDING: "bg-amber-500",
  PROCESSING: "bg-blue-500 animate-pulse",
  DONE: "bg-emerald-500",
  FAILED: "bg-red-500",
};

function scoreColors(score: number) {
  if (score >= 70) return { text: "text-emerald-700", bar: "bg-emerald-500", chip: "bg-emerald-50" };
  if (score >= 40) return { text: "text-amber-700", bar: "bg-amber-500", chip: "bg-amber-50" };
  return { text: "text-red-700", bar: "bg-red-500", chip: "bg-red-50" };
}

const POLL_INTERVAL_MS = 5000;

/** refreshToken: bump it from the parent to force an immediate re-fetch. */
export default function ApplicationsHistory({ refreshToken }: { refreshToken: number }) {
  const [items, setItems] = useState<JobApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-item UI state, keyed by applicationId.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  // Read inside the interval below without making it a dependency - putting
  // `items` in the effect's dependency array would tear down and restart
  // the interval on every fetch, which defeats the point of an interval.
  const itemsRef = useRef<JobApplication[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const load = useCallback(async () => {
    try {
      const res = await listApplications();
      setItems(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void load();

    // There's no push channel yet (no WebSocket/SNS) for the backend to
    // tell the frontend "this application finished processing" - polling
    // is how the UI notices a PENDING/PROCESSING row settle. Stops calling
    // load() once nothing is in flight, so an idle, fully-settled history
    // doesn't hit the API every 5 seconds forever. Edits and deletes below
    // call load() directly too, so their result shows up immediately
    // rather than waiting for the next tick.
    const timer = setInterval(() => {
      const stillInFlight = itemsRef.current.some(
        (item) => item.status === "PENDING" || item.status === "PROCESSING",
      );
      if (stillInFlight) void load();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [refreshToken, load]);

  function startEdit(item: JobApplication) {
    setEditingId(item.applicationId);
    setEditText(item.jobDescription);
    setRowError((prev) => ({ ...prev, [item.applicationId]: "" }));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditText("");
  }

  async function saveEdit(applicationId: string) {
    const jobDescription = editText.trim();
    if (!jobDescription) return;
    setBusyId(applicationId);
    try {
      await updateApplication(applicationId, jobDescription);
      setEditingId(null);
      await load(); // picks up the reset-to-PENDING state right away
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [applicationId]: err instanceof Error ? err.message : "Update failed",
      }));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(applicationId: string) {
    if (!window.confirm("Delete this application? This can't be undone.")) return;
    setBusyId(applicationId);
    try {
      await deleteApplication(applicationId);
      setItems((prev) => prev.filter((i) => i.applicationId !== applicationId));
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [applicationId]: err instanceof Error ? err.message : "Delete failed",
      }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-900/5">
      <div className="flex items-center gap-3 border-b border-slate-100 bg-gradient-to-r from-emerald-50 to-teal-50 px-6 py-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-base text-white shadow-sm">
          📋
        </span>
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Your applications
          </h2>
          <p className="text-sm text-slate-500">Tracked, scored, and ready to edit.</p>
        </div>
      </div>

      <div className="p-6">
        {loading && <p className="text-sm text-slate-500">Loading…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!loading && !error && items.length === 0 && (
          <p className="text-sm text-slate-500">
            No applications yet &mdash; submit a job description above.
          </p>
        )}
        <ul className="space-y-3">
          {items.map((item) => {
            const isEditing = editingId === item.applicationId;
            const isBusy = busyId === item.applicationId;
            const err = rowError[item.applicationId];
            const colors = item.matchScore !== undefined ? scoreColors(item.matchScore) : null;

            return (
              <li
                key={item.applicationId}
                className={`rounded-lg border border-slate-200 border-l-4 bg-white p-3 shadow-sm transition hover:shadow-md ${
                  STATUS_BORDER[item.status] ?? "border-l-slate-300"
                }`}
              >
                <div className="mb-1 flex items-center justify-between gap-3">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
                      STATUS_STYLES[item.status] ?? "bg-slate-100 text-slate-700"
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[item.status] ?? "bg-slate-400"}`} />
                    {item.status}
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                </div>

                {isEditing ? (
                  <div className="mt-1">
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={5}
                      className="mb-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => saveEdit(item.applicationId)}
                        disabled={isBusy || !editText.trim()}
                        className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1 text-xs font-medium text-white shadow-sm hover:from-violet-500 hover:to-fuchsia-500 disabled:opacity-50"
                      >
                        {isBusy ? "Saving…" : "Save"}
                      </button>
                      <button
                        onClick={cancelEdit}
                        disabled={isBusy}
                        className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="line-clamp-2 text-sm text-slate-600">
                      {item.jobDescription}
                    </p>

                    {item.matchScore !== undefined && colors && (
                      <div className={`mt-2 rounded-md p-2 ${colors.chip}`}>
                        <div className="mb-1 flex items-center justify-between">
                          <p className={`text-xs font-semibold ${colors.text}`}>
                            Match score: {item.matchScore}%
                          </p>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/70">
                          <div
                            className={`h-full rounded-full ${colors.bar}`}
                            style={{ width: `${Math.min(100, Math.max(0, item.matchScore))}%` }}
                          />
                        </div>
                        {item.gapAnalysis && item.gapAnalysis.length > 0 && (
                          <p className="mt-1.5 text-xs text-slate-500">
                            Gaps: {item.gapAnalysis.join(", ")}
                          </p>
                        )}
                      </div>
                    )}

                    {item.status === "FAILED" && item.errorMessage && (
                      <p className="mt-2 text-xs text-red-600">{item.errorMessage}</p>
                    )}

                    <div className="mt-2 flex gap-4">
                      <button
                        onClick={() => startEdit(item)}
                        disabled={isBusy}
                        className="text-xs font-medium text-violet-600 hover:text-violet-800 disabled:opacity-50"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(item.applicationId)}
                        disabled={isBusy}
                        className="text-xs font-medium text-red-500 hover:text-red-700 disabled:opacity-50"
                      >
                        {isBusy ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </>
                )}

                {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
