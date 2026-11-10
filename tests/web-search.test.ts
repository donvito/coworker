import { describe, expect, it, vi } from "vitest";
import { MemoryCredentialStore } from "@main/security/credential-store";
import { searchWeb, webSearchCredentialKey } from "@main/integrations/web-search";

describe("web search skill provider selection", () => {
  it("uses an available provider and returns normalized source records", async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.set(webSearchCredentialKey("tavily"), "tvly-test");
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "Primary documentation",
              url: "https://docs.example.test/reference",
              content: "  Current reference content.  ",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as typeof fetch;

    await expect(
      searchWeb({ credentials, query: "current API reference", fetcher }),
    ).resolves.toEqual({
      provider: "tavily",
      query: "current API reference",
      results: [
        {
          title: "Primary documentation",
          url: "https://docs.example.test/reference",
          snippet: "Current reference content.",
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("falls back when the preferred configured provider fails", async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.set(webSearchCredentialKey("exa"), "exa-test");
    await credentials.set(webSearchCredentialKey("tavily"), "tvly-test");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ) as typeof fetch;

    const result = await searchWeb({
      credentials,
      query: "fallback",
      preferredProvider: "exa",
      fetcher,
    });
    expect(result.provider).toBe("tavily");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  const firecrawlResponse = () =>
    new Response(
      JSON.stringify({
        success: true,
        data: {
          web: [{ url: "https://news.example.test/launch", title: "Launch", description: "Shipped today.", position: 1 }],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("searches Firecrawl's free tier without a key when none is configured", async () => {
    const fetcher = vi.fn(async () => firecrawlResponse()) as typeof fetch;

    await expect(
      searchWeb({ credentials: new MemoryCredentialStore(), query: "launch news", limit: 3, fetcher }),
    ).resolves.toEqual({
      provider: "firecrawl",
      query: "launch news",
      results: [{ title: "Launch", url: "https://news.example.test/launch", snippet: "Shipped today." }],
    });
    const [url, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(url).toBe("https://api.firecrawl.dev/v2/search");
    expect(init?.headers).not.toHaveProperty("Authorization");
    expect(JSON.parse(String(init?.body))).toEqual({ query: "launch news", limit: 3 });
  });

  it("sends a saved Firecrawl key", async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.set(webSearchCredentialKey("firecrawl"), "fc-test");
    const fetcher = vi.fn(async () => firecrawlResponse()) as typeof fetch;

    const result = await searchWeb({ credentials, query: "launch news", fetcher });

    expect(result.provider).toBe("firecrawl");
    expect(result.results).toHaveLength(1);
    expect(vi.mocked(fetcher).mock.calls[0]![1]?.headers).toMatchObject({ Authorization: "Bearer fc-test" });
  });

  it("explains how to keep searching once the free daily limit is used up", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 429 })) as typeof fetch;

    await expect(
      searchWeb({ credentials: new MemoryCredentialStore(), query: "anything", fetcher }),
    ).rejects.toThrow(/free search limit for today is used up.*Settings → Web search/);
  });

  it("does not fall back to the free tier when configured providers fail", async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.set(webSearchCredentialKey("tavily"), "tvly-test");
    const fetcher = vi.fn(async () => new Response("{}", { status: 503 })) as typeof fetch;

    await expect(searchWeb({ credentials, query: "anything", fetcher })).rejects.toThrow(
      "All configured search providers failed",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("web search image references", () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  async function credentialsFor(provider: "tavily" | "exa" | "serpapi") {
    const credentials = new MemoryCredentialStore();
    await credentials.set(webSearchCredentialKey(provider), "test-key");
    return credentials;
  }

  it("asks Firecrawl for images only on request and normalizes them", async () => {
    const fetcher = vi.fn(async () =>
      json({
        success: true,
        data: {
          web: [{ url: "https://stays.example.com/rooms/1", title: "Beach villa", description: "Sleeps four." }],
          images: [
            {
              title: "Beach villa pool",
              imageUrl: "https://cdn.example.com/villa.jpg?im_w=720",
              imageWidth: 720,
              imageHeight: 480,
              url: "https://stays.example.com/rooms/1",
              position: 1,
            },
            { title: "Insecure", imageUrl: "http://cdn.example.com/plain.jpg", url: "https://stays.example.com/rooms/2" },
            { title: "Inline", imageUrl: "data:image/png;base64,AAAA" },
            { title: "Local", imageUrl: "https://192.168.1.4/camera.jpg" },
            { title: "Repeat", imageUrl: "https://cdn.example.com/villa.jpg?im_w=720" },
          ],
        },
      }),
    ) as typeof fetch;

    await expect(
      searchWeb({
        credentials: new MemoryCredentialStore(),
        query: "beach villa",
        limit: 4,
        includeImages: true,
        fetcher,
      }),
    ).resolves.toEqual({
      provider: "firecrawl",
      query: "beach villa",
      results: [{ title: "Beach villa", url: "https://stays.example.com/rooms/1", snippet: "Sleeps four." }],
      images: [
        {
          url: "https://cdn.example.com/villa.jpg?im_w=720",
          title: "Beach villa pool",
          sourceUrl: "https://stays.example.com/rooms/1",
          width: 720,
          height: 480,
        },
      ],
    });
    expect(JSON.parse(String(vi.mocked(fetcher).mock.calls[0]![1]?.body))).toEqual({
      query: "beach villa",
      limit: 4,
      sources: ["web", "images"],
    });
  });

  it("returns an empty image list when a provider has none, and no key when not requested", async () => {
    const fetcher = vi.fn(async () =>
      json({ success: true, data: { web: [{ url: "https://news.example.test/a", title: "A" }] } }),
    ) as typeof fetch;
    const credentials = new MemoryCredentialStore();

    const withImages = await searchWeb({ credentials, query: "a", includeImages: true, fetcher });
    expect(withImages.images).toEqual([]);

    const without = await searchWeb({ credentials, query: "a", fetcher });
    expect(without).not.toHaveProperty("images");
  });

  it("normalizes Tavily image lists in both shapes", async () => {
    const fetcher = vi.fn(async () =>
      json({
        results: [{ title: "Venue", url: "https://venues.example.com/loft", content: "Holds sixty." }],
        images: [
          "https://cdn.example.com/loft-1.jpg",
          { url: "https://cdn.example.com/loft-2.jpg", description: "Loft main hall" },
          { url: "ftp://cdn.example.com/loft-3.jpg", description: "Unsupported scheme" },
          7,
        ],
      }),
    ) as typeof fetch;

    const result = await searchWeb({
      credentials: await credentialsFor("tavily"),
      query: "venue",
      includeImages: true,
      fetcher,
    });
    expect(result.images).toEqual([
      { url: "https://cdn.example.com/loft-1.jpg", title: "", sourceUrl: null },
      { url: "https://cdn.example.com/loft-2.jpg", title: "Loft main hall", sourceUrl: null },
    ]);
    expect(JSON.parse(String(vi.mocked(fetcher).mock.calls[0]![1]?.body))).toMatchObject({
      include_images: true,
      include_image_descriptions: true,
    });

    const plain = vi.fn(async () => json({ results: [] })) as typeof fetch;
    await searchWeb({ credentials: await credentialsFor("tavily"), query: "venue", fetcher: plain });
    expect(JSON.parse(String(vi.mocked(plain).mock.calls[0]![1]?.body))).not.toHaveProperty("include_images");
  });

  it("uses each Exa result's representative image", async () => {
    const fetcher = vi.fn(async () =>
      json({
        results: [
          { title: "Desk A", url: "https://shop.example.com/a", text: "Oak.", image: "https://cdn.example.com/desk-a.jpg" },
          { title: "Desk B", url: "https://shop.example.com/b", text: "Steel." },
        ],
      }),
    ) as typeof fetch;

    const result = await searchWeb({
      credentials: await credentialsFor("exa"),
      query: "standing desk",
      includeImages: true,
      fetcher,
    });
    expect(result.images).toEqual([
      { url: "https://cdn.example.com/desk-a.jpg", title: "Desk A", sourceUrl: "https://shop.example.com/a" },
    ]);
  });

  it("prefers SerpAPI inline originals and keeps organic thumbnails", async () => {
    const fetcher = vi.fn(async () =>
      json({
        organic_results: [
          {
            title: "Kyoto restaurant",
            link: "https://food.example.com/kyoto",
            snippet: "Seasonal menu.",
            thumbnail: "https://thumbs.example.com/kyoto.jpg",
          },
        ],
        inline_images: [
          {
            title: "Dining room",
            original: "https://cdn.example.com/dining.jpg",
            thumbnail: "https://thumbs.example.com/dining-small.jpg",
            source: "https://food.example.com/kyoto",
          },
        ],
      }),
    ) as typeof fetch;

    const result = await searchWeb({
      credentials: await credentialsFor("serpapi"),
      query: "kyoto restaurant",
      includeImages: true,
      fetcher,
    });
    expect(result.images).toEqual([
      { url: "https://cdn.example.com/dining.jpg", title: "Dining room", sourceUrl: "https://food.example.com/kyoto" },
      { url: "https://thumbs.example.com/kyoto.jpg", title: "Kyoto restaurant", sourceUrl: "https://food.example.com/kyoto" },
    ]);
  });
});
