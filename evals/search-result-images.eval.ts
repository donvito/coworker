import { afterAll, beforeAll, expect, vi } from "vitest";
import { describeEval } from "vitest-evals";
import { coworkerHarness, type CoworkerEvalInput } from "./harness/coworker-harness";
import { hasRecording, liveModel, recordingPath } from "./harness/model-transcript";

/**
 * The skill decides when a search answer deserves photos. These scenarios
 * check that decision with a real model: image-worthy searches load the
 * skill and attach returned images; searches on overlapping subjects that
 * are answered in text do not.
 */
const scenarios = [
  {
    name: "shows photos for a place-to-stay search",
    prompt: "Find me an Airbnb in Lisbon for four people in May. Give me three options.",
    shouldShowImages: true,
  },
  {
    name: "shows photos for an event venue search",
    prompt: "Search for venues near Austin that could host a 60-person team offsite and recommend two.",
    shouldShowImages: true,
  },
  {
    name: "shows a photo when asked what something looks like",
    prompt: "Search the web and show me what Fallingwater, the Frank Lloyd Wright house, looks like.",
    shouldShowImages: true,
  },
  {
    name: "does not show photos for a policy question about a travel site",
    prompt: "Search the web for Airbnb's current refund policy for long stays and summarize it.",
    shouldShowImages: false,
  },
  {
    name: "does not show photos for a technical how-to search",
    prompt: "Search the web for how to configure CORS in Express and summarize the steps.",
    shouldShowImages: false,
  },
  {
    name: "does not show photos for a quick factual lookup",
    prompt: "Search the web: what is the latest Node.js LTS version?",
    shouldShowImages: false,
  },
  {
    name: "does not show photos when the user asks for text only",
    prompt: "Find three hotels in Kyoto near Gion. Text only, no pictures please.",
    shouldShowImages: false,
  },
];

const live = liveModel();
const runnable = scenarios
  .filter((scenario) => live || hasRecording(scenario.name))
  .map(
    (scenario) =>
      ({
        ...scenario,
        enabledTools: [],
        bundledSkillNames: ["web-search", "search-result-images"],
        transcriptPath: recordingPath(scenario.name),
        ...(live ? { model: live } : {}),
        expected: {},
      }) satisfies CoworkerEvalInput & { shouldShowImages: boolean },
  );

/** A search provider stand-in, so the eval grades the model's choices rather than live results. */
function searchProviderResponse(body: { query?: string; limit?: number; sources?: string[] }): Response {
  const query = body.query ?? "search";
  const count = Math.min(body.limit ?? 5, 4);
  const slug = encodeURIComponent(query.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40));
  const web = Array.from({ length: count }, (_, index) => ({
    url: `https://results.example.com/${slug}/${index + 1}`,
    title: `${query}: option ${index + 1}`,
    description: `Details about option ${index + 1} for ${query}.`,
  }));
  const images = Array.from({ length: count }, (_, index) => ({
    title: `Photo of option ${index + 1} for ${query}`,
    imageUrl: `https://photos.example.com/${slug}/${index + 1}.jpg`,
    imageWidth: 1200,
    imageHeight: 800,
    url: web[index]!.url,
  }));
  return new Response(
    JSON.stringify({
      success: true,
      data: { web, ...(body.sources?.includes("images") ? { images } : {}) },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describeEval(
  "search result images skill routing",
  {
    harness: coworkerHarness,
    skipIf: () => runnable.length === 0,
  },
  (it) => {
    const realFetch = globalThis.fetch;
    beforeAll(() => {
      vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.startsWith("https://api.firecrawl.dev/")) return realFetch(input, init);
        return searchProviderResponse(JSON.parse(String(init?.body ?? "{}")));
      }) as typeof fetch);
    });
    afterAll(() => vi.unstubAllGlobals());

    it.for(runnable)("$name", async (scenario, { run }) => {
      const result = await run(scenario);
      expect(result.output.error).toBeNull();
      const calls = result.output.toolCalls;
      const loadedSkill = calls.some(
        (call) =>
          call.name === "skills.read" && JSON.stringify(call.arguments).includes("search-result-images"),
      );
      const attached = calls.filter(
        (call) => call.name === "chat.attach_images" && call.status === "COMPLETED",
      );
      const askedForImages = calls.some(
        (call) => call.name === "web.search" && JSON.stringify(call.arguments).includes('"includeImages":true'),
      );

      if (scenario.shouldShowImages) {
        expect(loadedSkill).toBe(true);
        expect(askedForImages).toBe(true);
        expect(attached.length).toBeGreaterThanOrEqual(1);
        const shown = attached.flatMap(
          (call) => (call.result as { images?: unknown[] } | null)?.images ?? [],
        );
        expect(shown.length).toBeGreaterThanOrEqual(1);
        expect(shown.length).toBeLessThanOrEqual(6);
      } else {
        expect(calls.some((call) => call.name === "chat.attach_images")).toBe(false);
      }
      const reply = result.output.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.content)
        .join("\n");
      expect(reply).not.toMatch(/!\[[^\]]*\]\(/);
      expect(reply).not.toContain("photos.example.com");
    });
  },
);
