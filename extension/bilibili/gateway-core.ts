export type JsonTransport = (url: string) => Promise<unknown>;

export function isBiliUrl(url: unknown): boolean {
  try {
    const parsed = new URL(String(url || ""));
    const host = parsed.hostname;
    return host === "api.bilibili.com" || host.endsWith(".hdslb.com");
  } catch {
    return false;
  }
}

export async function bgFetchJson<T = unknown>(url: string): Promise<T> {
  const headers = new Headers();
  const isBiliRequest = isBiliUrl(url);
  if (isBiliRequest) {
    headers.set("Accept", "application/json, text/plain, */*");
    headers.set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
    headers.set("Cache-Control", "no-cache");
    headers.set("Pragma", "no-cache");
  }

  const options: RequestInit = {
    method: "GET",
    credentials: "include",
    cache: "no-store"
  };
  if ((headers as unknown as { size: number }).size > 0) {
    options.headers = headers;
  }
  if (isBiliRequest) {
    options.referrer = "https://www.bilibili.com/";
    options.referrerPolicy = "strict-origin-when-cross-origin";
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}
