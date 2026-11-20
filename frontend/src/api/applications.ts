import { apiFetch } from "./client";

export interface JobApplication {
  applicationId: string;
  jobDescription: string;
  status: string;
  createdAt: string;
  // Only present once processing has finished (or failed).
  matchScore?: number;
  gapAnalysis?: string[];
  coverLetterS3Key?: string;
  errorMessage?: string;
}

/** POST /applications - create a new PENDING application from JD text. */
export function createApplication(jobDescription: string): Promise<JobApplication> {
  return apiFetch<JobApplication>("/applications", {
    method: "POST",
    body: JSON.stringify({ jobDescription }),
  });
}

/** GET /applications - every application belonging to the signed-in user. */
export async function listApplications(): Promise<JobApplication[]> {
  const { items } = await apiFetch<{ items: JobApplication[] }>("/applications");
  return items;
}

/**
 * PUT /applications/{id} - change the JD text. Resets status to PENDING
 * and clears any previous matchScore/gapAnalysis/cover letter server-side
 * (they're stale once the text has changed), then re-queues the
 * application for processing against the new text.
 */
export function updateApplication(
  applicationId: string,
  jobDescription: string,
): Promise<{ applicationId: string; status: string }> {
  return apiFetch(`/applications/${encodeURIComponent(applicationId)}`, {
    method: "PUT",
    body: JSON.stringify({ jobDescription }),
  });
}

/** DELETE /applications/{id}. */
export function deleteApplication(applicationId: string): Promise<void> {
  return apiFetch(`/applications/${encodeURIComponent(applicationId)}`, {
    method: "DELETE",
  });
}
