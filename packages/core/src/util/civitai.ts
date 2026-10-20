/**
 * Civitai access. Many of its files download only for a signed-in account,
 * which an API token stands in for. As with HuggingFace's token, it goes to
 * Civitai's own hosts only: a download redirects to a signed storage URL that
 * must not receive it (fetch drops `Authorization` on a cross-origin redirect,
 * and nothing here re-adds it).
 */

export function isCivitaiUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'civitai.com' || host.endsWith('.civitai.com');
  } catch {
    return false;
  }
}

export function civitaiAuthHeaders(url: string, token?: string): Record<string, string> {
  if (!token || !isCivitaiUrl(url)) return {};
  return { Authorization: `Bearer ${token}` };
}

export function civitaiDeniedHint(status: number): string {
  return `Civitai refused the download (${status}). This file needs a signed-in account: set CIVITAI_TOKEN to an API key from civitai.com/user/account.`;
}
