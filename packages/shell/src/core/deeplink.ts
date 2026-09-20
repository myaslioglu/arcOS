const APP_ID = /^[a-z][a-z0-9-]*$/;

export function formatAppHash(appId: string, params: Record<string, string> = {}): string {
  const keys = Object.keys(params).sort();
  if (keys.length === 0) return `#app:${appId}`;
  const q = new URLSearchParams();
  for (const k of keys) q.set(k, params[k]!);
  return `#app:${appId}?${q.toString()}`;
}

export function parseAppHash(hash: string): { appId: string; params: Record<string, string> } | null {
  if (!hash.startsWith("#app:")) return null;
  const [appId = "", query = ""] = hash.slice(5).split("?");
  if (!APP_ID.test(appId)) return null;
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  return { appId, params };
}
