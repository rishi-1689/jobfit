import { FormEvent, useState } from "react";
import { createApplication } from "../api/applications";

export default function JobDescriptionForm({ onCreated }: { onCreated: () => void }) {
  const [jobDescription, setJobDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!jobDescription.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createApplication(jobDescription);
      setJobDescription("");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-900/5">
      <div className="flex items-center gap-3 border-b border-slate-100 bg-gradient-to-r from-violet-50 to-fuchsia-50 px-6 py-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-base text-white shadow-sm">
          📝
        </span>
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Submit a job description
          </h2>
          <p className="text-sm text-slate-500">
            We&rsquo;ll score your resume against it and draft a cover letter automatically.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="p-6">
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <textarea
          value={jobDescription}
          onChange={(e) => setJobDescription(e.target.value)}
          rows={6}
          placeholder="Paste the job description here…"
          className="mb-3 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
        />
        <button
          type="submit"
          disabled={busy || !jobDescription.trim()}
          className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:from-violet-500 hover:to-fuchsia-500 disabled:opacity-50"
        >
          {busy ? "Submitting…" : "Submit"}
        </button>
      </form>
    </section>
  );
}
