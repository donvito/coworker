import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { ImageAttachmentData } from "@shared/contracts";
import { publicHttpsUrl } from "@shared/message-images";

export const maxRemoteImageBytes = 8 * 1024 * 1024;
const maxRedirects = 3;
const requestTimeoutMs = 15_000;

const nonPublicAddresses = new BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  nonPublicAddresses.addSubnet(prefix, bits, "ipv4");
}
for (const [prefix, bits] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  nonPublicAddresses.addSubnet(prefix, bits, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  const mapped = family === 6 ? address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1] : undefined;
  if (mapped) return !nonPublicAddresses.check(mapped, "ipv4");
  return !nonPublicAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

export type HostResolver = (hostname: string) => Promise<string[]>;

const resolveWithDns: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

/** Sniffs the real format; a server's declared content type is not trusted. */
export function sniffImageMimeType(data: Uint8Array): string | null {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  const head = bytes.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(4, 8).toString("latin1") === "ftyp" &&
    ["avif", "avis"].includes(bytes.subarray(8, 12).toString("latin1"))
  ) {
    return "image/avif";
  }
  return null;
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) throw new Error("The image is larger than 8 MB");
  if (!response.body) throw new Error("The image response was empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("The image is larger than 8 MB");
    }
    chunks.push(value);
  }
  if (total === 0) throw new Error("The image response was empty");
  return Buffer.concat(chunks, total);
}

/**
 * Downloads one remote image for display. Only public HTTPS hosts are
 * contacted, every redirect is validated again, no cookies or referrer are
 * sent, and the body must be a bounded raster image.
 */
export async function fetchRemoteImage(
  value: string,
  options: { fetcher?: typeof fetch; resolveHost?: HostResolver; timeoutMs?: number } = {},
): Promise<ImageAttachmentData> {
  const fetcher = options.fetcher ?? fetch;
  const resolveHost = options.resolveHost ?? resolveWithDns;
  const signal = AbortSignal.timeout(options.timeoutMs ?? requestTimeoutMs);
  let current = publicHttpsUrl(value);
  if (!current) throw new Error("Images must come from a public HTTPS address");
  for (let redirects = 0; ; redirects += 1) {
    const url = new URL(current);
    const addresses = await resolveHost(url.hostname).catch(() => []);
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
      throw new Error("The image host is not a public address");
    }
    const response = await fetcher(url, {
      headers: {
        Accept: "image/jpeg,image/png,image/webp,image/gif,image/avif;q=0.8",
        "User-Agent": "Coworker/1.0 (image preview)",
      },
      credentials: "omit",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      const next = location ? publicHttpsUrl(new URL(location, url).toString()) : null;
      if (!next) throw new Error("The image redirected to an address that cannot be shown");
      if (redirects >= maxRedirects) throw new Error("The image redirected too many times");
      current = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`The image could not be downloaded (${response.status})`);
    }
    const bytes = await readLimited(response, maxRemoteImageBytes);
    const mimeType = sniffImageMimeType(bytes);
    if (!mimeType) throw new Error("The address did not return a JPEG, PNG, WebP, GIF, or AVIF image");
    return { data: Buffer.from(bytes).toString("base64"), mimeType };
  }
}

/** Shares in-flight downloads and keeps recently shown images in a bounded memory cache. */
export class RemoteImageLoader {
  private readonly cache = new Map<string, ImageAttachmentData>();
  private readonly pending = new Map<string, Promise<ImageAttachmentData>>();
  private cachedBytes = 0;

  constructor(
    private readonly options: {
      fetcher?: typeof fetch;
      resolveHost?: HostResolver;
      maxCacheBytes?: number;
    } = {},
  ) {}

  load(url: string): Promise<ImageAttachmentData> {
    const cached = this.cache.get(url);
    if (cached) {
      this.cache.delete(url);
      this.cache.set(url, cached);
      return Promise.resolve(cached);
    }
    const inFlight = this.pending.get(url);
    if (inFlight) return inFlight;
    const request = fetchRemoteImage(url, this.options)
      .then((image) => {
        this.remember(url, image);
        return image;
      })
      .finally(() => this.pending.delete(url));
    this.pending.set(url, request);
    return request;
  }

  private remember(url: string, image: ImageAttachmentData): void {
    const limit = this.options.maxCacheBytes ?? 96 * 1024 * 1024;
    if (image.data.length > limit) return;
    this.cache.set(url, image);
    this.cachedBytes += image.data.length;
    for (const [key, value] of this.cache) {
      if (this.cachedBytes <= limit) break;
      this.cache.delete(key);
      this.cachedBytes -= value.data.length;
    }
  }
}
