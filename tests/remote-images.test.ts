import { describe, expect, it, vi } from "vitest";
import {
  RemoteImageLoader,
  fetchRemoteImage,
  isPublicAddress,
  maxRemoteImageBytes,
  sniffImageMimeType,
} from "@main/integrations/remote-images";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const publicHost = async () => ["93.184.216.34"];

function imageResponse(body: Buffer = png, init: ResponseInit = {}) {
  return new Response(new Uint8Array(body), { status: 200, headers: { "content-type": "text/plain" }, ...init });
}

describe("remote image addresses", () => {
  it("treats loopback, private, link-local, and reserved ranges as non-public", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.9",
      "192.168.1.20",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "not-an-address",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it("identifies images by signature rather than by declared type", () => {
    expect(sniffImageMimeType(png)).toBe("image/png");
    expect(sniffImageMimeType(jpeg)).toBe("image/jpeg");
    expect(sniffImageMimeType(Buffer.from("GIF89a....."))).toBe("image/gif");
    expect(sniffImageMimeType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageMimeType(Buffer.from("\0\0\0\x1cftypavif\0\0\0\0", "latin1"))).toBe("image/avif");
    expect(sniffImageMimeType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageMimeType(Buffer.from("<html><script>alert(1)</script></html>"))).toBeNull();
  });
});

describe("remote image download boundary", () => {
  it("downloads a public image without cookies, referrer, or automatic redirects", async () => {
    const fetcher = vi.fn(async () => imageResponse()) as unknown as typeof fetch;
    const image = await fetchRemoteImage("https://cdn.example.com/villa.png", {
      fetcher,
      resolveHost: publicHost,
    });
    expect(image).toEqual({ data: png.toString("base64"), mimeType: "image/png" });
    const [url, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(String(url)).toBe("https://cdn.example.com/villa.png");
    expect(init).toMatchObject({
      credentials: "omit",
      redirect: "manual",
      referrerPolicy: "no-referrer",
    });
  });

  it("refuses addresses that are not public HTTPS before any request", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const resolveHost = vi.fn(publicHost);
    for (const url of [
      "http://cdn.example.com/a.png",
      "https://127.0.0.1/a.png",
      "https://localhost/a.png",
      "file:///etc/passwd",
    ]) {
      await expect(fetchRemoteImage(url, { fetcher, resolveHost })).rejects.toThrow("public HTTPS");
    }
    expect(resolveHost).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses public names that resolve to a private or unknown address", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    for (const addresses of [["10.0.0.5"], ["93.184.216.34", "127.0.0.1"], []]) {
      await expect(
        fetchRemoteImage("https://rebind.example.com/a.png", {
          fetcher,
          resolveHost: async () => addresses,
        }),
      ).rejects.toThrow("not a public address");
    }
    await expect(
      fetchRemoteImage("https://missing.example.com/a.png", {
        fetcher,
        resolveHost: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toThrow("not a public address");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates every redirect and stops redirect chains", async () => {
    const redirect = (location: string) =>
      new Response(null, { status: 302, headers: { location } });

    const followed = vi
      .fn()
      .mockResolvedValueOnce(redirect("/moved/villa.png"))
      .mockResolvedValueOnce(imageResponse(jpeg)) as unknown as typeof fetch;
    await expect(
      fetchRemoteImage("https://cdn.example.com/villa.png", { fetcher: followed, resolveHost: publicHost }),
    ).resolves.toMatchObject({ mimeType: "image/jpeg" });
    expect(String(vi.mocked(followed).mock.calls[1]![0])).toBe("https://cdn.example.com/moved/villa.png");

    for (const location of ["http://cdn.example.com/a.png", "https://192.168.0.1/a.png", "https://router.local/a.png"]) {
      const fetcher = vi.fn(async () => redirect(location)) as unknown as typeof fetch;
      await expect(
        fetchRemoteImage("https://cdn.example.com/villa.png", { fetcher, resolveHost: publicHost }),
      ).rejects.toThrow("redirected to an address that cannot be shown");
      expect(fetcher).toHaveBeenCalledTimes(1);
    }

    const privateAfterRedirect = vi.fn(async () => redirect("https://internal.example.net/a.png")) as unknown as typeof fetch;
    await expect(
      fetchRemoteImage("https://cdn.example.com/villa.png", {
        fetcher: privateAfterRedirect,
        resolveHost: async (hostname) => (hostname === "cdn.example.com" ? ["93.184.216.34"] : ["10.0.0.8"]),
      }),
    ).rejects.toThrow("not a public address");
    expect(privateAfterRedirect).toHaveBeenCalledTimes(1);

    const loop = vi.fn(async () => redirect("https://cdn.example.com/again.png")) as unknown as typeof fetch;
    await expect(
      fetchRemoteImage("https://cdn.example.com/villa.png", { fetcher: loop, resolveHost: publicHost }),
    ).rejects.toThrow("too many times");
    expect(loop).toHaveBeenCalledTimes(4);
  });

  it("rejects failures, non-images, empty bodies, and oversized bodies", async () => {
    const cases: Array<[Response, string]> = [
      [new Response("missing", { status: 404 }), "could not be downloaded (404)"],
      [
        new Response("<html><body>Sign in</body></html>", { headers: { "content-type": "image/png" } }),
        "did not return a JPEG",
      ],
      [
        new Response("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>", {
          headers: { "content-type": "image/svg+xml" },
        }),
        "did not return a JPEG",
      ],
      [new Response(new Uint8Array(0)), "empty"],
      [imageResponse(png, { headers: { "content-length": String(maxRemoteImageBytes + 1) } }), "larger than 8 MB"],
      [imageResponse(Buffer.concat([png, Buffer.alloc(maxRemoteImageBytes)])), "larger than 8 MB"],
    ];
    for (const [response, message] of cases) {
      const fetcher = vi.fn(async () => response) as unknown as typeof fetch;
      await expect(
        fetchRemoteImage("https://cdn.example.com/a.png", { fetcher, resolveHost: publicHost }),
      ).rejects.toThrow(message);
    }
  });

  it("gives up on an image that is too slow", async () => {
    const fetcher = vi.fn(
      (_url: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof fetch;
    await expect(
      fetchRemoteImage("https://slow.example.com/a.png", { fetcher, resolveHost: publicHost, timeoutMs: 20 }),
    ).rejects.toThrow();
  });
});

describe("remote image loader", () => {
  it("shares concurrent downloads and serves repeats from memory", async () => {
    const fetcher = vi.fn(async () => imageResponse()) as unknown as typeof fetch;
    const loader = new RemoteImageLoader({ fetcher, resolveHost: publicHost });
    const [first, second] = await Promise.all([
      loader.load("https://cdn.example.com/a.png"),
      loader.load("https://cdn.example.com/a.png"),
    ]);
    expect(first).toEqual(second);
    await loader.load("https://cdn.example.com/a.png");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries after a failure and evicts the oldest image past its budget", async () => {
    const failing = vi
      .fn()
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockImplementation(async () => imageResponse()) as unknown as typeof fetch;
    const retrying = new RemoteImageLoader({ fetcher: failing, resolveHost: publicHost });
    await expect(retrying.load("https://cdn.example.com/a.png")).rejects.toThrow("503");
    await expect(retrying.load("https://cdn.example.com/a.png")).resolves.toMatchObject({ mimeType: "image/png" });

    const fetcher = vi.fn(async () => imageResponse()) as unknown as typeof fetch;
    const small = new RemoteImageLoader({
      fetcher,
      resolveHost: publicHost,
      maxCacheBytes: png.toString("base64").length,
    });
    await small.load("https://cdn.example.com/a.png");
    await small.load("https://cdn.example.com/b.png");
    await small.load("https://cdn.example.com/b.png");
    expect(fetcher).toHaveBeenCalledTimes(2);
    await small.load("https://cdn.example.com/a.png");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
