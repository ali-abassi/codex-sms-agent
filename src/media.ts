import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

export type DownloadedMedia = {
  path: string;
  contentType: string;
  isImage: boolean;
  bytes: number;
  sourceUrl: string;
};

export type DownloadMediaOptions = {
  url: string;
  handle: string;
  root: string;
  fetch?: typeof globalThis.fetch;
  maxBytes?: number;
  timeoutMs?: number;
};

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

const extensionsByType: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "video/mp4": ".mp4",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "application/pdf": ".pdf",
};

function assertSendblueMediaUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const trustedHost =
    host === "sendblue.co" ||
    host.endsWith(".sendblue.co") ||
    host === "sendblue.com" ||
    host.endsWith(".sendblue.com");
  if (url.protocol !== "https:" || !trustedHost || url.username || url.password) {
    throw new Error("Inbound media URL is not a trusted Sendblue HTTPS URL");
  }
  return url;
}

function safeName(handle: string): string {
  const value = handle.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return value || "message";
}

function extensionFor(url: URL, contentType: string): string {
  const documented = extensionsByType[contentType];
  if (documented) return documented;
  const extension = extname(url.pathname).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".bin";
}

async function fetchValidated(
  initial: URL,
  fetcher: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<{ response: Response; url: URL }> {
  let url = initial;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetcher(url, { redirect: "manual", signal });
    if (response.status < 300 || response.status >= 400) return { response, url };
    const location = response.headers.get("location");
    if (!location || redirects === MAX_REDIRECTS) {
      throw new Error("Inbound media redirected without a trusted destination");
    }
    url = assertSendblueMediaUrl(new URL(location, url).toString());
  }
  throw new Error("Inbound media exceeded redirect limit");
}

export async function downloadInboundMedia(
  options: DownloadMediaOptions,
): Promise<DownloadedMedia> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const initial = assertSendblueMediaUrl(options.url);
  const { response, url } = await fetchValidated(initial, fetcher, signal);
  if (!response.ok) throw new Error(`Inbound media download failed with HTTP ${response.status}`);

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Inbound media exceeds the ${maxBytes}-byte limit`);
  }
  if (!response.body) throw new Error("Inbound media response had no body");

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel("size limit");
        throw new Error(`Inbound media exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
  const directory = join(options.root, safeName(options.handle));
  const path = join(directory, `attachment${extensionFor(url, contentType)}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, Buffer.concat(chunks), { mode: 0o600 });

  return {
    path,
    contentType,
    isImage: contentType.startsWith("image/"),
    bytes,
    sourceUrl: url.toString(),
  };
}
