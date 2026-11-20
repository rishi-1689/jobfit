import { apiFetch } from "./client";

export interface AdminSettings {
  useLiveAI: boolean;
  /** True once a real key has been saved - the key itself is never returned. */
  apiKeyConfigured: boolean;
}

export interface AdminUser {
  userId: string;
  email?: string;
  name?: string;
  applicationCount: number;
  /** null = using the global default; a number = an admin-set override. */
  applicationQuota: number | null;
  effectiveQuota: number;
}

export function getAdminSettings(): Promise<AdminSettings> {
  return apiFetch<AdminSettings>("/admin/settings");
}

export function setUseLiveAI(useLiveAI: boolean): Promise<{ useLiveAI: boolean }> {
  return apiFetch("/admin/settings", {
    method: "PUT",
    body: JSON.stringify({ useLiveAI }),
  });
}

/** Write-only: the backend stores it as a SecureString and never returns it. */
export function setApiKey(apiKey: string): Promise<{ apiKeyConfigured: boolean }> {
  return apiFetch("/admin/api-key", {
    method: "PUT",
    body: JSON.stringify({ apiKey }),
  });
}

export function listAdminUsers(): Promise<{ users: AdminUser[]; defaultQuota: number }> {
  return apiFetch("/admin/users");
}

export function setUserQuota(
  userId: string,
  quota: number,
): Promise<{ userId: string; applicationQuota: number }> {
  return apiFetch(`/admin/users/${encodeURIComponent(userId)}/quota`, {
    method: "PUT",
    body: JSON.stringify({ quota }),
  });
}
