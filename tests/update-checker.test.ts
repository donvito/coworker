import { afterEach, describe, expect, it, vi } from "vitest";
import { AppUpdateChecker, configuredReleaseSource, newestStableRelease, updateCheckTimeoutMs } from "@main/app/update-checker";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const release = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, draft: false, prerelease: false, ...extra });
const json = (body: unknown, headers?: HeadersInit) => new Response(JSON.stringify(body), { headers });

function fixture(currentVersion = "0.7.0", releases: unknown = [release("v0.8.0")]) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(releases));
  const openExternal = vi.fn().mockResolvedValue(undefined);
  const checker = new AppUpdateChecker({ currentVersion, fetcher, openExternal });
  return { checker, fetcher, openExternal };
}

describe("notification-only release checks", () => {
  it("uses the configured public repository without credentials", async () => {
    expect(configuredReleaseSource()).toEqual({ owner: "donvito", repo: "coworker" });
    const { checker, fetcher } = fixture();
    const state = await checker.check();
    expect(state).toEqual({ checking: false, availableVersion: "0.8.0", notice: { kind: "available", version: "0.8.0" } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/repos/donvito/coworker/releases?per_page=100&page=1");
    expect(init?.method).toBe("GET");
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["0.9.0", "v0.10.0", true],
    ["1.9.9", "1.10.0", true],
    ["1.2.9", "v1.2.10", true],
    ["1.2.10", "v1.2.9", false],
    ["v1.2.3", "1.2.3", false],
    ["2.0.0", "1.99.99", false],
    ["1.2.3+local", "v1.2.3+release", false],
    ["1.2.3-rc.1", "v1.2.3", true],
  ])("compares %s to %s with SemVer", async (current, tag, available) => {
    const { checker } = fixture(current, [release(tag)]);
    expect((await checker.check(true)).notice?.kind).toBe(available ? "available" : "up-to-date");
  });

  it("ignores drafts, prereleases, malformed tags, and missing release flags", () => {
    expect(newestStableRelease([
      release("v9.0.0", { draft: true }),
      release("v8.0.0", { prerelease: true }),
      ...["v7.0.0-beta.1", "next", "v01.2.3", "1.2", "release-6.0.0", " 5.0.0 ", "=4.0.0", "vv3.0.0"].map(tag => release(tag)),
      { tag_name: "v2.0.0" }, null,
      release("v0.9.0"), release("v0.10.0"), release("v0.8.0"),
    ])).toEqual({ version: "0.10.0", tag: "v0.10.0" });
  });

  it("checks additional release pages using the same timeout and a trusted URL", async () => {
    const { checker, fetcher } = fixture();
    fetcher.mockReset()
      .mockResolvedValueOnce(json([release("next")], { link: '<https://evil.example/releases>; rel="next"' }))
      .mockResolvedValueOnce(json([release("v1.0.0")]));
    expect((await checker.check()).notice).toEqual({ kind: "available", version: "1.0.0" });
    expect(String(fetcher.mock.calls[1]![0])).toBe("https://api.github.com/repos/donvito/coworker/releases?per_page=100&page=2");
    expect(fetcher.mock.calls[1]![1]?.signal).toBe(fetcher.mock.calls[0]![1]?.signal);
  });

  it("stays quiet on startup when current or when no stable releases exist", async () => {
    for (const releases of [[], [release("v0.7.0")], [release("v9.0.0-rc.1")]]) {
      const { checker } = fixture("0.7.0", releases);
      expect(await checker.check()).toEqual({ checking: false, availableVersion: null, notice: null });
      expect((await checker.check(true)).notice).toEqual({ kind: "up-to-date" });
    }
  });

  it("fails quietly offline on startup and reports an actionable manual-check error", async () => {
    const { checker, fetcher } = fixture();
    fetcher.mockRejectedValue(new TypeError("fetch failed"));
    expect(await checker.check()).toEqual({ checking: false, availableVersion: null, notice: null });
    expect((await checker.check(true)).notice).toEqual({ kind: "error", message: "Could not reach GitHub. Check your internet connection and try again." });
  });

  it.each([403, 429, 404, 500])("reports GitHub HTTP %s failures on manual checks", async status => {
    const { checker, fetcher } = fixture();
    fetcher.mockResolvedValue(new Response("GitHub unavailable", { status }));
    const result = await checker.check(true);
    expect(result.checking).toBe(false);
    expect(result.notice?.kind).toBe("error");
    if (result.notice?.kind === "error") expect(result.notice.message).toMatch(status === 403 || status === 429 ? /limiting.*try again/ : new RegExp(`HTTP ${status}`));
  });

  it.each(["{invalid json", JSON.stringify({ message: "not a release list" })])("rejects malformed responses", async body => {
    const { checker, fetcher } = fixture();
    fetcher.mockResolvedValue(new Response(body));
    const result = await checker.check(true);
    expect(result.notice?.kind).toBe("error");
    if (result.notice?.kind === "error") expect(result.notice.message).toMatch(/invalid release list/);
  });

  it("times out a stalled request without blocking startup or throwing", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const { checker, fetcher } = fixture();
    fetcher.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason));
    }));
    const pending = checker.check(true);
    expect(checker.getState()).toEqual({ checking: true, availableVersion: null, notice: { kind: "checking" } });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(updateCheckTimeoutMs);
    await vi.advanceTimersByTimeAsync(updateCheckTimeoutMs);
    expect((await pending).notice).toEqual({ kind: "error", message: "The update check timed out. Please try again." });
  });

  it("coalesces concurrent startup/menu checks and shows the manual result", async () => {
    const { checker, fetcher } = fixture();
    let finish!: (response: Response) => void;
    fetcher.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const startup = checker.check();
    expect(checker.getState()).toEqual({ checking: true, availableVersion: null, notice: null });
    const manual = checker.check(true);
    expect(manual).toBe(startup);
    expect(fetcher).toHaveBeenCalledOnce();
    finish(json([]));
    expect((await startup).notice).toEqual({ kind: "up-to-date" });
  });

  it("keeps Later dismissal for the app session, while manual checks can redisplay it", async () => {
    const { checker } = fixture();
    await checker.check();
    expect(checker.dismiss().notice).toBeNull();
    expect(checker.getState().notice).toBeNull();
    expect((await checker.check()).notice).toBeNull();
    expect((await checker.check(true)).notice?.kind).toBe("available");
    expect((await fixture().checker.check()).notice?.kind).toBe("available");
  });

  it("opens only a constructed GitHub release page, ignoring untrusted response links", async () => {
    const { checker, openExternal } = fixture("0.7.0", [release("v0.8.0+build.1", { html_url: "https://evil.example/file.dmg", assets: [{ browser_download_url: "https://evil.example/file" }] })]);
    await expect(checker.openRelease()).rejects.toThrow("No update release");
    await checker.check();
    await checker.openRelease();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://github.com/donvito/coworker/releases/tag/v0.8.0%2Bbuild.1");
    checker.dismiss();
    await checker.openRelease();
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(checker.getState().availableVersion).toBe("0.8.0");
  });

  it("retains availability after Later and a failed recheck, then clears it after a successful current-version check", async () => {
    const { checker, fetcher, openExternal } = fixture();
    await checker.check();
    expect(checker.dismiss()).toEqual({ checking: false, availableVersion: "0.8.0", notice: null });
    fetcher.mockRejectedValueOnce(new TypeError("offline"));
    expect(await checker.check(true)).toEqual({ checking: false, availableVersion: "0.8.0", notice: { kind: "error", message: "Could not reach GitHub. Check your internet connection and try again." } });
    checker.dismiss();
    await checker.openRelease();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://github.com/donvito/coworker/releases/tag/v0.8.0");
    fetcher.mockResolvedValueOnce(json([release("v0.7.0")]));
    expect((await checker.check(true)).availableVersion).toBeNull();
    await expect(checker.openRelease()).rejects.toThrow("No update release");
  });

  it("emits state changes and cleans up subscribers", async () => {
    const { checker } = fixture();
    const listener = vi.fn();
    const unsubscribe = checker.subscribe(listener);
    await checker.check();
    expect(listener).toHaveBeenLastCalledWith(checker.getState());
    unsubscribe();
    checker.dismiss();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
