import { parse, gt, type SemVer } from "semver";
import packageManifest from "../../../package.json";
import type { AppUpdateState } from "@shared/contracts";

export const updateCheckTimeoutMs = 10_000;

export interface GitHubReleaseSource {
  owner: string;
  repo: string;
}

export function configuredReleaseSource(): GitHubReleaseSource {
  const source = packageManifest.build.publish.find((entry) => entry.provider === "github");
  if (!source) throw new Error("No GitHub release source is configured.");
  return { owner: source.owner, repo: source.repo };
}

interface StableRelease {
  version: string;
  tag: string;
}

function releaseVersion(tag: unknown): SemVer | null {
  if (typeof tag !== "string" || tag !== tag.trim()) return null;
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!/^\d/.test(version)) return null;
  return parse(version, { loose: false });
}

export function newestStableRelease(releases: unknown): StableRelease | null {
  if (!Array.isArray(releases)) throw new Error("GitHub returned an invalid release list.");
  let newest: StableRelease | null = null;
  for (const release of releases) {
    if (!release || typeof release !== "object" || release.draft !== false || release.prerelease !== false) continue;
    const version = releaseVersion(release.tag_name);
    if (!version || version.prerelease.length > 0) continue;
    if (!newest || gt(version, newest.version)) {
      newest = { version: version.version, tag: release.tag_name };
    }
  }
  return newest;
}

async function findUpdate(
  currentVersion: string,
  source: GitHubReleaseSource,
  fetcher: typeof fetch,
): Promise<StableRelease | null> {
  const runningVersion = releaseVersion(currentVersion);
  if (!runningVersion) throw new Error(`The running app version is invalid: ${currentVersion}.`);
  const signal = AbortSignal.timeout(updateCheckTimeoutMs);
  let newest: StableRelease | null = null;
  for (let page = 1; page <= 10; page += 1) {
    const url = new URL(`https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/releases`);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await fetcher(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": `Coworker/${currentVersion}`,
      },
      credentials: "omit",
      redirect: "error",
      signal,
    });
    if (response.status === 403 || response.status === 429) {
      throw new Error("GitHub is limiting release checks. Please try again later.");
    }
    if (!response.ok) throw new Error(`GitHub release check failed (HTTP ${response.status}).`);
    const candidate = newestStableRelease(await response.json());
    if (candidate && (!newest || gt(candidate.version, newest.version))) newest = candidate;
    // Construct pagination URLs ourselves rather than following server-provided links.
    if (!response.headers.get("link")?.includes('rel="next"')) {
      return newest && gt(newest.version, runningVersion) ? newest : null;
    }
  }
  throw new Error("GitHub returned too many releases to check. Please try again later.");
}

function failureMessage(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "The update check timed out. Please try again.";
  }
  if (error instanceof TypeError) return "Could not reach GitHub. Check your internet connection and try again.";
  if (error instanceof SyntaxError) return "GitHub returned an invalid release list. Please try again.";
  return error instanceof Error ? error.message : "Could not check for updates. Please try again.";
}

/** Notification state is kept in memory for the entire app session, independent of coworkers. */
export class AppUpdateChecker {
  private state: AppUpdateState = { checking: false, availableVersion: null, notice: null };
  private release: StableRelease | null = null;
  private dismissed = false;
  private manualRequested = false;
  private inFlight: Promise<AppUpdateState> | null = null;
  private readonly listeners = new Set<(state: AppUpdateState) => void>();
  private readonly source: GitHubReleaseSource;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: {
    currentVersion: string;
    openExternal: (url: string) => Promise<unknown>;
    source?: GitHubReleaseSource;
    fetcher?: typeof fetch;
  }) {
    this.source = options.source ?? configuredReleaseSource();
    this.fetcher = options.fetcher ?? fetch;
  }

  getState(): AppUpdateState {
    return this.state;
  }

  subscribe(listener: (state: AppUpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  check(manual = false): Promise<AppUpdateState> {
    if (manual) {
      this.manualRequested = true;
      this.dismissed = false;
    }
    if (this.inFlight) {
      if (manual) this.publish({ ...this.state, checking: true, notice: { kind: "checking" } });
      return this.inFlight;
    }
    this.manualRequested = manual;
    this.publish({ ...this.state, checking: true, notice: manual ? { kind: "checking" } : null });
    this.inFlight = this.runCheck().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  dismiss(): AppUpdateState {
    this.dismissed = true;
    this.publish({ ...this.state, notice: null });
    return this.state;
  }

  async openRelease(): Promise<void> {
    if (!this.release) throw new Error("No update release is available.");
    const url = `https://github.com/${encodeURIComponent(this.source.owner)}/${encodeURIComponent(this.source.repo)}/releases/tag/${encodeURIComponent(this.release.tag)}`;
    await this.options.openExternal(url);
  }

  private async runCheck(): Promise<AppUpdateState> {
    try {
      this.release = await findUpdate(this.options.currentVersion, this.source, this.fetcher);
      this.publish({
        checking: false,
        availableVersion: this.release?.version ?? null,
        notice: this.dismissed ? null : this.release
          ? { kind: "available", version: this.release.version }
          : this.manualRequested ? { kind: "up-to-date" } : null,
      });
    } catch (error) {
      // A failed recheck does not invalidate a previously verified release.
      this.publish({ ...this.state, checking: false, notice: this.manualRequested && !this.dismissed ? { kind: "error", message: failureMessage(error) } : null });
    }
    return this.state;
  }

  private publish(state: AppUpdateState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
