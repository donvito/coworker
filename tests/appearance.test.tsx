// @vitest-environment happy-dom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@shared/contracts";
import { initializeAppearance, useAppearance } from "@renderer/lib/appearance";

const cacheKey = "coworker.appearance";
type Appearance = Pick<AppSettings, "theme" | "colorMode">;

function mockSystemColorMode(initialDark = false) {
  let dark = initialDark;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    media: "(prefers-color-scheme: dark)",
    get matches() { return dark; },
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    }),
  };
  const matchMedia = vi.spyOn(window, "matchMedia").mockReturnValue(query as unknown as MediaQueryList);
  return {
    query,
    matchMedia,
    listeners,
    setDark(nextDark: boolean) {
      dark = nextDark;
      for (const listener of listeners) {
        listener({ matches: dark, media: query.media } as MediaQueryListEvent);
      }
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-color-mode");
  document.documentElement.style.removeProperty("color-scheme");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("appearance startup", () => {
  it("restores a cached dark theme before settings load, then adopts the saved snapshot", () => {
    mockSystemColorMode();
    localStorage.setItem(cacheKey, JSON.stringify({ theme: "plum", colorMode: "dark" }));
    initializeAppearance();
    expect(document.documentElement.dataset.theme).toBe("plum");
    expect(document.documentElement.dataset.colorMode).toBe("dark");

    const { rerender } = renderHook(({ settings }: { settings?: Appearance }) => useAppearance(settings), {
      initialProps: { settings: undefined } as { settings?: Appearance },
    });
    expect(document.documentElement.dataset.colorMode).toBe("dark");
    rerender({ settings: { theme: "ocean", colorMode: "light" } });
    expect(document.documentElement.dataset.theme).toBe("ocean");
    expect(document.documentElement.dataset.colorMode).toBe("light");
    expect(JSON.parse(localStorage.getItem(cacheKey)!)).toEqual({ theme: "ocean", colorMode: "light" });
  });

  it("resolves a cached system preference from the current OS appearance", () => {
    const system = mockSystemColorMode(true);
    localStorage.setItem(cacheKey, JSON.stringify({ theme: "clay", colorMode: "system" }));
    initializeAppearance();
    expect(system.matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
    expect(document.documentElement.dataset.theme).toBe("clay");
    expect(document.documentElement.dataset.colorMode).toBe("dark");
  });

  it.each([null, "not JSON", JSON.stringify({ theme: "invalid", colorMode: "invalid" })])(
    "uses safe startup defaults when the appearance cache is %s",
    (cached) => {
      mockSystemColorMode(true);
      if (cached !== null) localStorage.setItem(cacheKey, cached);
      expect(() => initializeAppearance()).not.toThrow();
      expect(document.documentElement.dataset.theme).toBe("graphite");
      expect(document.documentElement.dataset.colorMode).toBe("light");
    },
  );

  it("still starts and applies saved appearance when browser storage is unavailable", () => {
    mockSystemColorMode();
    const readCache = vi.fn(() => {
      throw new Error("Storage blocked");
    });
    const writeCache = vi.fn(() => {
      throw new Error("Storage blocked");
    });
    vi.stubGlobal("localStorage", { getItem: readCache, setItem: writeCache });
    expect(() => initializeAppearance()).not.toThrow();
    expect(readCache).toHaveBeenCalledWith(cacheKey);
    expect(document.documentElement.dataset.colorMode).toBe("light");
    expect(() => renderHook(() => useAppearance({ theme: "forest", colorMode: "dark" }))).not.toThrow();
    expect(writeCache).toHaveBeenCalledWith(cacheKey, JSON.stringify({ theme: "forest", colorMode: "dark" }));
    expect(document.documentElement.dataset.theme).toBe("forest");
    expect(document.documentElement.dataset.colorMode).toBe("dark");
  });
});

describe("appearance updates", () => {
  it("follows OS changes in system mode, retains the color theme, and removes its listener on unmount", () => {
    const system = mockSystemColorMode();
    const { unmount } = renderHook(() => useAppearance({ theme: "ocean", colorMode: "system" }));
    expect(document.documentElement.dataset.theme).toBe("ocean");
    expect(document.documentElement.dataset.colorMode).toBe("light");
    expect(system.listeners.size).toBe(1);

    act(() => system.setDark(true));
    expect(document.documentElement.dataset.colorMode).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("ocean");
    expect(JSON.parse(localStorage.getItem(cacheKey)!)).toEqual({ theme: "ocean", colorMode: "system" });
    act(() => system.setDark(false));
    expect(document.documentElement.dataset.colorMode).toBe("light");

    unmount();
    expect(system.listeners.size).toBe(0);
    act(() => system.setDark(true));
    expect(document.documentElement.dataset.colorMode).toBe("light");
  });

  it("ignores OS changes after switching to an explicit mode and resumes following in system mode", () => {
    const system = mockSystemColorMode(true);
    const { rerender } = renderHook((settings: Appearance) => useAppearance(settings), {
      initialProps: { theme: "forest", colorMode: "system" } as Appearance,
    });
    expect(document.documentElement.dataset.colorMode).toBe("dark");

    rerender({ theme: "forest", colorMode: "light" });
    expect(document.documentElement.dataset.colorMode).toBe("light");
    act(() => system.setDark(false));
    act(() => system.setDark(true));
    expect(document.documentElement.dataset.colorMode).toBe("light");

    rerender({ theme: "plum", colorMode: "dark" });
    act(() => system.setDark(false));
    expect(document.documentElement.dataset.colorMode).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("plum");

    rerender({ theme: "plum", colorMode: "system" });
    expect(document.documentElement.dataset.colorMode).toBe("light");
    expect(system.listeners.size).toBe(1);
    act(() => system.setDark(true));
    expect(document.documentElement.dataset.colorMode).toBe("dark");
  });
});
