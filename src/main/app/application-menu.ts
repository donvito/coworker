import type { MenuItemConstructorOptions } from "electron";

export function applicationMenuTemplate(input: {
  platform: NodeJS.Platform;
  onCheckForUpdates: () => void;
}): MenuItemConstructorOptions[] {
  const checkForUpdates: MenuItemConstructorOptions = {
    id: "check-for-updates",
    label: "Check for Updates",
    click: input.onCheckForUpdates,
  };
  const mac = input.platform === "darwin";
  return [
    ...(mac ? [{
      label: "Coworker",
      submenu: [
        { role: "about" },
        checkForUpdates,
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    } satisfies MenuItemConstructorOptions] : []),
    { label: "File", submenu: [{ role: mac ? "close" : "quit" }] },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    { role: "help", submenu: mac ? [] : [checkForUpdates] },
  ];
}
