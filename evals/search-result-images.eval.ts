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

interface FixtureResult {
  url: string;
  title: string;
  description: string;
  /** A photo the provider found on this page. */
  image: string;
}

/**
 * Realistic results for each scenario's subject. Placeholder results
 * ("option 1" on example.com) make a careful model rightly refuse to show
 * photos it cannot identify, which would grade the fixture, not the skill.
 * Every subject returns photos when asked, so skipping them is a decision.
 */
const fixtureTopics: Array<{ match: RegExp; results: FixtureResult[] }> = [
  {
    match: /lisbon/i,
    results: [
      { url: "https://www.airbnb.com/rooms/48213907", title: "Bright Alfama apartment with river view · 2 bedrooms · sleeps 4", description: "Renovated 2-bedroom flat in Alfama with a balcony over the Tagus, 5 minutes from Sé Cathedral. Sleeps 4. €165 per night in May.", image: "Living room with balcony and Tagus river view, Alfama apartment" },
      { url: "https://www.airbnb.com/rooms/51877214", title: "Príncipe Real townhouse loft with terrace · sleeps 4", description: "Two-level loft with a private terrace in Príncipe Real, near the garden and Bairro Alto. Sleeps 4. €190 per night.", image: "Rooftop terrace of a Príncipe Real townhouse loft" },
      { url: "https://www.airbnb.com/rooms/39940126", title: "Chiado family apartment near Rossio · 2 bathrooms · sleeps 5", description: "Classic Pombaline apartment with high ceilings in Chiado, 3 minutes from the metro. Sleeps 5. €175 per night.", image: "Bedroom with high ceilings and tall windows, Chiado apartment" },
      { url: "https://www.airbnb.com/rooms/60311845", title: "Belém garden flat near the river · sleeps 4", description: "Ground-floor flat with a small garden, walking distance to Belém Tower. Sleeps 4. €140 per night.", image: "Garden patio of a Belém flat" },
    ],
  },
  {
    match: /austin|offsite|venue/i,
    results: [
      { url: "https://www.lakeaustinretreat.com/corporate-events", title: "Lake Travis Retreat Lodge · corporate offsites for 20–80", description: "Hill Country lodge on Lake Travis, 35 minutes from downtown Austin. Meeting barn for 80, lakeside lawn, catering on site.", image: "Meeting barn set up for a 60-person workshop, Lake Travis Retreat Lodge" },
      { url: "https://www.southcongressevents.com/spaces/the-loft", title: "The Loft at South Congress · event space for 75", description: "Industrial loft venue on South Congress with AV, breakout rooms, and a rooftop deck. Seated capacity 75.", image: "Industrial loft event space with long tables, South Congress" },
      { url: "https://www.dripspringsranch.com/groups", title: "Driftwood Ranch · team retreats in Dripping Springs", description: "Ranch venue with an indoor hall for 100 and cabins for overnight groups, 40 minutes west of Austin.", image: "Ranch event hall with string lights, Dripping Springs" },
    ],
  },
  {
    match: /fallingwater|frank lloyd wright/i,
    results: [
      { url: "https://fallingwater.org/history/", title: "Fallingwater · History of the house", description: "Frank Lloyd Wright designed Fallingwater in 1935 for the Kaufmann family. Its cantilevered terraces extend over the waterfall on Bear Run in Mill Run, Pennsylvania.", image: "Fallingwater seen from below the falls, cantilevered terraces over Bear Run" },
      { url: "https://en.wikipedia.org/wiki/Fallingwater", title: "Fallingwater - Wikipedia", description: "Fallingwater is a house designed by Frank Lloyd Wright in 1935 in the Laurel Highlands of southwest Pennsylvania.", image: "Living room interior of Fallingwater with stone floor and built-in seating" },
    ],
  },
  {
    match: /kyoto|gion/i,
    results: [
      { url: "https://www.booking.com/hotel/jp/gion-hatanaka.html", title: "Gion Hatanaka · ryokan steps from Yasaka Shrine", description: "Traditional ryokan in Gion with kaiseki dinners and tatami rooms, 2 minutes from Yasaka Shrine.", image: "Tatami guest room at Gion Hatanaka ryokan" },
      { url: "https://www.booking.com/hotel/jp/the-gate-kyoto.html", title: "The Gate Hotel Kyoto Takasegawa · 6 minutes to Gion", description: "Modern hotel on the Takase River with a rooftop terrace overlooking Higashiyama.", image: "Rooftop terrace view over Higashiyama, The Gate Hotel Kyoto" },
      { url: "https://www.booking.com/hotel/jp/hotel-the-celestine-kyoto-gion.html", title: "Hotel The Celestine Kyoto Gion", description: "Contemporary hotel with a Japanese garden and public bath, a short walk to Gion and Kiyomizu-dera.", image: "Japanese garden courtyard, Hotel The Celestine Kyoto Gion" },
    ],
  },
  {
    match: /refund|cancellation|policy/i,
    results: [
      { url: "https://www.airbnb.com/help/article/475", title: "Cancellation policies for long-term stays - Airbnb Help Centre", description: "Stays of 28 nights or more use the long-term cancellation policy: the first 30 days are non-refundable if cancelled after booking, and the guest must give 30 days' notice to shorten the stay.", image: "Airbnb logo on a pink background" },
      { url: "https://www.airbnb.com/help/article/1320", title: "Airbnb Rebooking and Refund Policy", description: "If a host cancels or a significant issue disrupts the stay, Airbnb will help rebook or provide a full or partial refund.", image: "Screenshot of the Airbnb refund request screen" },
    ],
  },
  {
    match: /cors|express/i,
    results: [
      { url: "https://expressjs.com/en/resources/middleware/cors.html", title: "Express cors middleware", description: "Install with npm install cors, then app.use(cors()) to enable all CORS requests, or pass an options object with origin, methods, and credentials.", image: "Express.js logo" },
      { url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS", title: "Cross-Origin Resource Sharing (CORS) - MDN", description: "CORS is an HTTP-header based mechanism that lets a server indicate which origins other than its own a browser should permit loading resources from.", image: "Diagram of a CORS preflight request and response" },
    ],
  },
  {
    match: /node/i,
    results: [
      { url: "https://nodejs.org/en/about/previous-releases", title: "Node.js Releases", description: "Node.js 24 is the current Active LTS release line. Production applications should use Active LTS or Maintenance LTS releases.", image: "Node.js logo" },
      { url: "https://github.com/nodejs/release#release-schedule", title: "nodejs/release: Node.js release schedule", description: "Release schedule chart for the Node.js LTS lines with start, active, and end-of-life dates.", image: "Chart of the Node.js release schedule" },
    ],
  },
];

const fixtureImageHost = "https://images.searchcdn.net";

/** A search provider stand-in, so the eval grades the model's choices rather than live results. */
function searchProviderResponse(body: { query?: string; limit?: number; sources?: string[] }): Response {
  const query = body.query ?? "";
  const topic = fixtureTopics.find((candidate) => candidate.match.test(query)) ?? fixtureTopics[0]!;
  const results = topic.results.slice(0, body.limit ?? 5);
  const web = results.map(({ url, title, description }) => ({ url, title, description }));
  const images = results.map((result, index) => ({
    title: result.image,
    imageUrl: `${fixtureImageHost}/${new URL(result.url).hostname}/${index + 1}.jpg`,
    imageWidth: 1200,
    imageHeight: 800,
    url: result.url,
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
      expect(reply).not.toContain(fixtureImageHost);
    });
  },
);
