import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";
import { resolveWorkspacePath } from "@main/tools/workspace-path";

export type BrowserLocatorInput =
  | { by: "role"; role: string; name?: string; exact?: boolean }
  | { by: "label" | "text" | "placeholder" | "testId" | "css"; value: string; exact?: boolean };

export type BrowserActionInput =
  | { kind: "navigate"; url: string }
  | { kind: "back" | "forward" | "reload" }
  | { kind: "click"; target: BrowserLocatorInput; expectDownload?: boolean }
  | { kind: "fill"; target: BrowserLocatorInput; value: string }
  | { kind: "press"; target: BrowserLocatorInput; key: string }
  | { kind: "select"; target: BrowserLocatorInput; values: string[] }
  | { kind: "check" | "uncheck" | "hover"; target: BrowserLocatorInput }
  | { kind: "scroll"; deltaY: number }
  | { kind: "wait"; milliseconds: number }
  | { kind: "upload"; target: BrowserLocatorInput; paths: string[] }
  | { kind: "closePage" };

export interface BrowserObservation {
  pageId: string;
  pages: Array<{ pageId: string; title: string; url: string }>;
  title: string;
  url: string;
  accessibility: string;
  accessibilityTruncated: boolean;
  download?: { path: string; bytes: number; artifactId?: string };
}

export interface BrowserRichToolResult {
  __coworkerRichToolResult: true;
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: "image/jpeg" }
  >;
  details: BrowserObservation;
  audit: Omit<BrowserObservation, "accessibility"> & { accessibilityCharacters: number };
}

interface BrowserWorkspace {
  coworkerId: string;
  context: BrowserContext;
  pageIds: Map<Page, string>;
}

const maximumAccessibilityCharacters = 50_000;
const maximumDownloadBytes = 100 * 1024 * 1024;

function safeTopLevelUrl(value: string, allowBlank = false): URL {
  const url = new URL(value);
  if (allowBlank && url.protocol === "about:" && url.href === "about:blank") return url;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser navigation supports only HTTP and HTTPS pages");
  }
  return url;
}

function safeDownloadName(value: string): string {
  const cleaned = value
    .replaceAll(/[\\/\0]/g, "-")
    .replaceAll(/[^a-zA-Z0-9._ -]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return cleaned || "download";
}

export class BrowserAutomationService {
  private readonly workspaces = new Map<string, BrowserWorkspace>();
  private readonly grants = new Map<string, string>();

  constructor(
    private readonly dataPath: string,
    private readonly options: { headless?: boolean } = {},
  ) {
    const resourcesPath = Reflect.get(process, "resourcesPath");
    const packagedBrowserPath =
      typeof resourcesPath === "string"
        ? join(
            resourcesPath,
            "app.asar.unpacked",
            "node_modules",
            "playwright-core",
            ".local-browsers",
          )
        : null;
    process.env.PLAYWRIGHT_BROWSERS_PATH =
      packagedBrowserPath && existsSync(packagedBrowserPath)
        ? packagedBrowserPath
        : process.env.PLAYWRIGHT_BROWSERS_PATH ?? "0";
  }

  private profilePath(coworkerId: string): string {
    return join(this.dataPath, "browser-profiles", coworkerId);
  }

  private async workspace(coworkerId: string): Promise<BrowserWorkspace> {
    const existing = this.workspaces.get(coworkerId);
    if (existing) return existing;

    const profilePath = this.profilePath(coworkerId);
    await mkdir(profilePath, { recursive: true, mode: 0o700 });
    await chmod(profilePath, 0o700);
    const { chromium } = await import("playwright");
    const context = await chromium.launchPersistentContext(profilePath, {
      acceptDownloads: true,
      channel: "chromium",
      headless: this.options.headless ?? false,
      viewport: { width: 1280, height: 800 },
    });
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(30_000);
    const workspace: BrowserWorkspace = { coworkerId, context, pageIds: new Map() };
    this.workspaces.set(coworkerId, workspace);
    context.on("page", (page) => this.registerPage(workspace, page));
    context.on("close", () => {
      this.workspaces.delete(coworkerId);
      for (const [taskId, grantedCoworkerId] of this.grants) {
        if (grantedCoworkerId === coworkerId) this.grants.delete(taskId);
      }
    });
    for (const page of context.pages()) this.registerPage(workspace, page);
    return workspace;
  }

  private registerPage(workspace: BrowserWorkspace, page: Page): string {
    const existing = workspace.pageIds.get(page);
    if (existing) return existing;
    const id = randomUUID();
    workspace.pageIds.set(page, id);
    page.on("close", () => workspace.pageIds.delete(page));
    return id;
  }

  private requireWorkspace(taskId: string, coworkerId: string): BrowserWorkspace {
    if (this.grants.get(taskId) !== coworkerId) {
      throw new Error("This task does not have an active browser-control grant");
    }
    const workspace = this.workspaces.get(coworkerId);
    if (!workspace) throw new Error("The controlled browser is no longer open");
    return workspace;
  }

  private page(workspace: BrowserWorkspace, pageId?: string): Page {
    const pages = workspace.context.pages().filter((page) => !page.isClosed());
    if (pages.length === 0) throw new Error("The controlled browser has no open pages");
    if (!pageId) return pages.at(-1)!;
    const page = pages.find((candidate) => workspace.pageIds.get(candidate) === pageId);
    if (!page) throw new Error("The requested browser page is no longer open");
    return page;
  }

  private async target(page: Page, input: BrowserLocatorInput): Promise<Locator> {
    let locator: Locator;
    switch (input.by) {
      case "role":
        locator = page.getByRole(input.role as never, {
          name: input.name,
          exact: input.exact,
        });
        break;
      case "label":
        locator = page.getByLabel(input.value, { exact: input.exact });
        break;
      case "text":
        locator = page.getByText(input.value, { exact: input.exact });
        break;
      case "placeholder":
        locator = page.getByPlaceholder(input.value, { exact: input.exact });
        break;
      case "testId":
        locator = page.getByTestId(input.value);
        break;
      case "css":
        locator = page.locator(input.value);
        break;
    }
    const count = await locator.count();
    if (count === 0) throw new Error("The browser target was not found; inspect the page again");
    if (count > 1) throw new Error("The browser target is ambiguous; use a more specific locator");
    return locator;
  }

  async startSession(input: {
    taskId: string;
    coworkerId: string;
    startUrl?: string;
  }): Promise<{ granted: true; pageId: string; title: string; url: string }> {
    const workspace = await this.workspace(input.coworkerId);
    let page = workspace.context.pages().filter((candidate) => !candidate.isClosed()).at(-1);
    if (!page) {
      page = await workspace.context.newPage();
      this.registerPage(workspace, page);
    }
    if (input.startUrl) {
      const url = safeTopLevelUrl(input.startUrl).href;
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    await page.bringToFront();
    this.releaseCoworker(input.coworkerId);
    this.grants.set(input.taskId, input.coworkerId);
    return {
      granted: true,
      pageId: this.registerPage(workspace, page),
      title: await page.title(),
      url: page.url(),
    };
  }

  async inspect(input: {
    taskId: string;
    coworkerId: string;
    pageId?: string;
  }): Promise<BrowserRichToolResult> {
    const workspace = this.requireWorkspace(input.taskId, input.coworkerId);
    return this.observation(workspace, this.page(workspace, input.pageId));
  }

  async act(input: {
    taskId: string;
    coworkerId: string;
    workspacePath: string;
    pageId?: string;
    action: BrowserActionInput;
  }): Promise<BrowserRichToolResult> {
    const workspace = this.requireWorkspace(input.taskId, input.coworkerId);
    const page = this.page(workspace, input.pageId);
    const action = input.action;
    let downloadResult: BrowserObservation["download"];

    switch (action.kind) {
      case "navigate":
        await page.goto(safeTopLevelUrl(action.url).href, { waitUntil: "domcontentloaded" });
        break;
      case "back":
        await page.goBack({ waitUntil: "domcontentloaded" });
        break;
      case "forward":
        await page.goForward({ waitUntil: "domcontentloaded" });
        break;
      case "reload":
        await page.reload({ waitUntil: "domcontentloaded" });
        break;
      case "click": {
        const target = await this.target(page, action.target);
        if (action.expectDownload) {
          const [download] = await Promise.all([
            page.waitForEvent("download"),
            target.click(),
          ]);
          const name = `${Date.now().toString(36)}-${safeDownloadName(download.suggestedFilename())}`;
          const relativePath = `downloads/${name}`;
          const destination = await resolveWorkspacePath(input.workspacePath, relativePath, {
            createParent: true,
          });
          await download.saveAs(destination);
          const size = (await stat(destination)).size;
          if (size > maximumDownloadBytes) {
            await rm(destination, { force: true });
            throw new Error("The browser download exceeded the 100 MB limit");
          }
          downloadResult = { path: relativePath, bytes: size };
        } else {
          await target.click();
        }
        break;
      }
      case "fill": {
        const target = await this.target(page, action.target);
        const inputType = (await target.getAttribute("type"))?.toLowerCase();
        if (inputType === "password") {
          throw new Error("Passwords must be entered by the user in the visible browser");
        }
        await target.fill(action.value);
        break;
      }
      case "press":
        await (await this.target(page, action.target)).press(action.key);
        break;
      case "select":
        await (await this.target(page, action.target)).selectOption(action.values);
        break;
      case "check":
        await (await this.target(page, action.target)).check();
        break;
      case "uncheck":
        await (await this.target(page, action.target)).uncheck();
        break;
      case "hover":
        await (await this.target(page, action.target)).hover();
        break;
      case "scroll":
        await page.mouse.wheel(0, action.deltaY);
        break;
      case "wait":
        await page.waitForTimeout(action.milliseconds);
        break;
      case "upload": {
        const paths = await Promise.all(
          action.paths.map((path) => resolveWorkspacePath(input.workspacePath, path)),
        );
        await (await this.target(page, action.target)).setInputFiles(paths);
        break;
      }
      case "closePage":
        if (workspace.context.pages().filter((candidate) => !candidate.isClosed()).length <= 1) {
          throw new Error("Use browser.close to close the browser's final page");
        }
        await page.close();
        break;
    }

    const current = action.kind === "closePage" ? this.page(workspace) : page;
    const result = await this.observation(workspace, current);
    if (downloadResult) {
      result.details.download = downloadResult;
      result.audit.download = downloadResult;
      result.content[0] = { type: "text", text: JSON.stringify(result.details) };
    }
    return result;
  }

  private async observation(
    workspace: BrowserWorkspace,
    page: Page,
  ): Promise<BrowserRichToolResult> {
    try {
      safeTopLevelUrl(page.url(), true);
    } catch (error) {
      await page.close().catch(() => undefined);
      throw error;
    }
    await page.bringToFront();
    const rawAccessibility = await page.locator("body").ariaSnapshot({ timeout: 5_000 });
    const accessibilityTruncated = rawAccessibility.length > maximumAccessibilityCharacters;
    const accessibility = rawAccessibility.slice(0, maximumAccessibilityCharacters);
    const pages: BrowserObservation["pages"] = [];
    for (const candidate of workspace.context.pages().filter((item) => !item.isClosed())) {
      try {
        safeTopLevelUrl(candidate.url(), true);
      } catch {
        await candidate.close().catch(() => undefined);
        continue;
      }
      pages.push({
        pageId: this.registerPage(workspace, candidate),
        title: await candidate.title(),
        url: candidate.url(),
      });
    }
    const details: BrowserObservation = {
      pageId: this.registerPage(workspace, page),
      pages,
      title: await page.title(),
      url: page.url(),
      accessibility,
      accessibilityTruncated,
    };
    const screenshot = await page.screenshot({ type: "jpeg", quality: 70 });
    return {
      __coworkerRichToolResult: true,
      content: [
        { type: "text", text: JSON.stringify(details) },
        { type: "image", data: screenshot.toString("base64"), mimeType: "image/jpeg" },
      ],
      details,
      audit: {
        pageId: details.pageId,
        pages: details.pages,
        title: details.title,
        url: details.url,
        accessibilityTruncated,
        accessibilityCharacters: accessibility.length,
      },
    };
  }

  releaseTask(taskId: string): void {
    this.grants.delete(taskId);
  }

  releaseCoworker(coworkerId: string): void {
    for (const [taskId, grantedCoworkerId] of this.grants) {
      if (grantedCoworkerId === coworkerId) this.grants.delete(taskId);
    }
  }

  async closeCoworker(coworkerId: string): Promise<void> {
    this.releaseCoworker(coworkerId);
    const workspace = this.workspaces.get(coworkerId);
    if (workspace) await workspace.context.close();
  }

  async closeForTask(taskId: string, coworkerId: string): Promise<void> {
    this.requireWorkspace(taskId, coworkerId);
    await this.closeCoworker(coworkerId);
  }

  async clearProfile(coworkerId: string): Promise<void> {
    await this.closeCoworker(coworkerId);
    await rm(this.profilePath(coworkerId), { recursive: true, force: true });
  }

  async closeAll(): Promise<void> {
    this.grants.clear();
    const contexts = [...this.workspaces.values()].map((workspace) => workspace.context);
    await Promise.allSettled(contexts.map((context) => context.close()));
    this.workspaces.clear();
  }
}

export function isBrowserRichToolResult(value: unknown): value is BrowserRichToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "__coworkerRichToolResult" in value &&
    value.__coworkerRichToolResult === true
  );
}
