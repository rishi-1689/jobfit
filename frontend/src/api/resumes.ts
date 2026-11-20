import { apiFetch } from "./client";

interface PresignedUrlResponse {
  uploadUrl: string;
  key: string;
}

/**
 * Upload a resume: ask the backend for a presigned S3 PUT URL (scoped to
 * this user, valid for 5 minutes - see the presigned-url Lambda), then PUT
 * the file bytes straight to S3 from the browser. Returns the S3 key the
 * file was stored under.
 */
export async function uploadResume(file: File): Promise<string> {
  const contentType = file.type || "application/octet-stream";

  const { uploadUrl, key } = await apiFetch<PresignedUrlResponse>(
    "/resumes/presigned-url",
    {
      method: "POST",
      body: JSON.stringify({ fileName: file.name, contentType }),
    },
  );

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
  });

  if (!putRes.ok) {
    throw new Error(`Upload to S3 failed (${putRes.status})`);
  }

  return key;
}
