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

  it("requires at least one configured provider", async () => {
    await expect(
      searchWeb({ credentials: new MemoryCredentialStore(), query: "anything" }),
    ).rejects.toThrow("Configure a Tavily, Exa, Firecrawl, or SerpAPI key");
  });
});
