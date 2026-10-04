import { describe, expect, it, vi } from "vitest";
import type { KeyboardEvent, MenuItem, MenuItemConstructorOptions } from "electron";
import { applicationMenuTemplate } from "@main/app/application-menu";

describe("application update menu", () => {
  it.each(["darwin", "win32", "linux"] as const)("adds a working Check for Updates item on %s", platform => {
    const check = vi.fn();
    const menu = applicationMenuTemplate({ platform, onCheckForUpdates: check });
    const parent = menu.find(item => platform === "darwin" ? item.label === "Coworker" : item.role === "help")!;
    const entries = parent.submenu as MenuItemConstructorOptions[];
    const item = entries.find(entry => entry.id === "check-for-updates")!;
    expect(item.label).toBe("Check for Updates");
    item.click?.({} as MenuItem, undefined, {} as KeyboardEvent);
    expect(check).toHaveBeenCalledOnce();
    expect(menu.map(entry => entry.role)).toEqual(expect.arrayContaining(["editMenu", "viewMenu", "windowMenu"]));
    if (platform === "darwin") expect(entries.map(entry => entry.role)).toEqual(expect.arrayContaining(["about", "hide", "quit"]));
  });
});
