import { useState } from "react";
import { uploadResume } from "../api/resumes";

type Status = "idle" | "uploading" | "done" | "error";

export default function ResumeUploadCard() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);

  async function handleUpload() {
    if (!file) return;
    setStatus("uploading");
    setError(null);
    try {
      const uploadedKey = await uploadResume(file);
      setKey(uploadedKey);
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setStatus("error");
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-900/5">
      <div className="flex items-center gap-3 border-b border-slate-100 bg-gradient-to-r from-sky-50 to-blue-50 px-6 py-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-blue-600 text-base text-white shadow-sm">
          📄
        </span>
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Resume</h2>
          <p className="text-sm text-slate-500">
            PDF works best &mdash; it&rsquo;s what gets you a real match score.
          </p>
        </div>
      </div>

      <div className="p-6">
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept=".pdf,.doc,.docx"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setStatus("idle");
            }}
            className="text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-sky-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-sky-700 hover:file:bg-sky-100"
          />
          <button
            onClick={handleUpload}
            disabled={!file || status === "uploading"}
            className="rounded-md bg-gradient-to-r from-sky-500 to-blue-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:from-sky-400 hover:to-blue-500 disabled:opacity-50"
          >
            {status === "uploading" ? "Uploading…" : "Upload"}
          </button>
        </div>
        {status === "done" && (
          <p className="mt-3 flex items-center gap-1.5 text-sm text-emerald-600">
            <span>✓</span> Uploaded as {key}
          </p>
        )}
        {status === "error" && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </div>
    </section>
  );
}
