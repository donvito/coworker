// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AvatarPhotoControl } from "@renderer/components/AvatarPhotoControl";
import { CoworkerSettingsModal } from "@renderer/components/CoworkerSettingsModal";
import { CreateCoworkerModal } from "@renderer/pages/CoworkersPage";
import type { Coworker } from "@shared/contracts";

const oldPhoto = "data:image/jpeg;base64,b2xk";
const croppedPhoto = "data:image/jpeg;base64,Y3JvcHBlZA==";
let bitmap: ImageBitmap;
let drawImage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  bitmap = { width: 1200, height: 800, close: vi.fn() } as unknown as ImageBitmap;
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage, fillRect: vi.fn(), clearRect: vi.fn() } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(croppedPhoto);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function pickPhoto(container: HTMLElement) {
  // Creation/settings are rendered in a portal outside the render container.
  const input = container.querySelector<HTMLInputElement>('input[type="file"]') ?? screen.getByLabelText("Avatar photo");
  expect(input).not.toBeNull();
  fireEvent.change(input!, { target: { files: [new File(["photo"], "portrait.jpg", { type: "image/jpeg" })] } });
  const dialog = await screen.findByRole("dialog", { name: /Crop photo/i });
  await waitFor(() => expect((within(dialog).getByRole("button", { name: "Apply crop" }) as HTMLButtonElement).disabled).toBe(false));
  return dialog;
}

async function applyCrop(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole("button", { name: "Apply crop" }));
  await waitFor(() => expect(dialog.isConnected).toBe(false));
}

describe("avatar crop interaction", () => {
  it("stages selection and applies the chosen crop only after confirmation", async () => {
    const onChange = vi.fn();
    const { container } = render(<AvatarPhotoControl photo={oldPhoto} onChange={onChange} />);
    const dialog = await pickPhoto(container);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByAltText("Uploaded photo preview").getAttribute("src")).toBe(oldPhoto);
    fireEvent.change(within(dialog).getByRole("slider", { name: /Zoom/i }), { target: { value: "2" } });
    const position = within(dialog).getByLabelText(/Position photo/i);
    fireEvent.keyDown(position, { key: "ArrowLeft" });
    await applyCrop(dialog);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(croppedPhoto);
    expect(screen.queryByRole("dialog", { name: /Crop photo/i })).toBeNull();
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Replace photo" }));
    const exportDraw = drawImage.mock.calls.find((call) => call[7] === 256 && call[8] === 256);
    expect(exportDraw?.slice(2, 5)).toEqual([200, 400, 400]);
    expect(exportDraw?.[1]).toBeGreaterThan(400);
  });

  it("cancel and Escape preserve the old avatar and do not close the underlying dialog", async () => {
    const onChange = vi.fn();
    const parentClose = vi.fn();
    const parentSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const { container } = render(
      <div onMouseDown={parentClose}>
        <form onSubmit={parentSubmit}><AvatarPhotoControl photo={oldPhoto} onChange={onChange} /></form>
      </div>,
    );
    let dialog = await pickPhoto(container);
    fireEvent.mouseDown(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(parentClose).not.toHaveBeenCalled();
    expect(parentSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Replace photo" }));
    const anotherBitmap = { width: 800, height: 1200, close: vi.fn() } as unknown as ImageBitmap;
    vi.mocked(createImageBitmap).mockResolvedValue(anotherBitmap);
    dialog = await pickPhoto(container);
    const parentEscape = vi.fn();
    document.addEventListener("keydown", parentEscape);
    try {
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(parentEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", parentEscape);
    }
    expect(anotherBitmap.close).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: /Crop photo/i })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("contains focus and moves the crop using arrow keys without submitting the form", async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const control = render(<form onSubmit={onSubmit}><AvatarPhotoControl photo={null} onChange={onChange} /></form>);
    const dialog = await pickPhoto(control.container);
    const apply = within(dialog).getByRole("button", { name: "Apply crop" });
    apply.focus();
    control.rerender(<form onSubmit={onSubmit}><AvatarPhotoControl photo={null} onChange={onChange} /></form>);
    expect(document.activeElement).toBe(apply);
    fireEvent.keyDown(apply, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(apply);
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(apply);
    const position = within(dialog).getByLabelText(/Position photo/i);
    const before = drawImage.mock.calls.at(-1)!;
    fireEvent.keyDown(position, { key: "ArrowLeft" });
    const after = drawImage.mock.calls.at(-1)!;
    expect(after[1]).toBeGreaterThan(before[1]);
    fireEvent.click(apply);
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(croppedPhoto);
  });

  it("drags using the displayed crop size and clamps to the image edge", async () => {
    const control = render(<AvatarPhotoControl photo={null} onChange={vi.fn()} />);
    const dialog = await pickPhoto(control.container);
    const position = within(dialog).getByLabelText(/Position photo/i) as HTMLCanvasElement;
    Object.defineProperty(position, "setPointerCapture", { value: vi.fn(), configurable: true });
    vi.spyOn(position, "getBoundingClientRect").mockReturnValue({ width: 360, height: 360 } as DOMRect);
    fireEvent.pointerDown(position, { pointerId: 1, button: 0, clientX: 180, clientY: 180 });
    fireEvent.pointerMove(position, { pointerId: 1, clientX: 90, clientY: 180 });
    // 90 viewport pixels is 200 source pixels at the initial 800px crop.
    expect(drawImage.mock.calls.at(-1)?.slice(1, 5)).toEqual([400, 0, 800, 800]);
    fireEvent.pointerMove(position, { pointerId: 1, clientX: -1000, clientY: 180 });
    expect(drawImage.mock.calls.at(-1)?.slice(1, 5)).toEqual([400, 0, 800, 800]);
    fireEvent.pointerUp(position, { pointerId: 1 });
    fireEvent.pointerMove(position, { pointerId: 1, clientX: 0, clientY: 180 });
    expect(drawImage.mock.calls.at(-1)?.slice(1, 5)).toEqual([400, 0, 800, 800]);
  });

  it("releases a stale decode without replacing a newer selection", async () => {
    const pending: ((bitmap: ImageBitmap) => void)[] = [];
    vi.mocked(createImageBitmap).mockImplementation(() => new Promise<ImageBitmap>((resolve) => pending.push(resolve)));
    const onChange = vi.fn();
    const control = render(<AvatarPhotoControl photo={oldPhoto} onChange={onChange} />);
    const input = control.container.querySelector('input[type="file"]')!;
    const file = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.change(input, { target: { files: [file] } });
    const newer = { width: 800, height: 1200, close: vi.fn() } as unknown as ImageBitmap;
    await act(async () => pending[1]!(newer));
    await act(async () => pending[0]!(bitmap));
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(newer.close).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: /Crop photo/i });
    await applyCrop(dialog);
    expect(newer.close).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(croppedPhoto);
  });

  it("keeps the prior avatar on invalid files, decode failure, or export failure", async () => {
    const onChange = vi.fn();
    const { container } = render(<AvatarPhotoControl photo={oldPhoto} onChange={onChange} />);
    const input = container.querySelector('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(["svg"], "photo.svg", { type: "image/svg+xml" })] } });
    expect((await screen.findByRole("alert")).textContent).toMatch(/PNG.*JPEG.*WebP/);
    expect(createImageBitmap).not.toHaveBeenCalled();
    vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error("corrupt image"));
    fireEvent.change(input, { target: { files: [new File(["photo"], "photo.jpg", { type: "image/jpeg" })] } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/could not be read/));
    const dialog = await pickPhoto(container);
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementationOnce(() => { throw new Error("Encoding failed"); });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply crop" }));
    expect(within(dialog).getByRole("alert").textContent).toMatch(/Encoding failed/);
    expect(onChange).not.toHaveBeenCalled();
    expect(bitmap.close).not.toHaveBeenCalled();
    await applyCrop(dialog);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(croppedPhoto);
  });

  it("discards pending images when unmounted or disabled and releases the bitmap", async () => {
    let finishDecode!: (value: ImageBitmap) => void;
    vi.mocked(createImageBitmap).mockImplementation(() => new Promise<ImageBitmap>((resolve) => { finishDecode = resolve; }));
    const onChange = vi.fn();
    const { container, unmount } = render(<AvatarPhotoControl photo={oldPhoto} onChange={onChange} />);
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["photo"], "photo.jpg", { type: "image/jpeg" })] },
    });
    unmount();
    await act(async () => finishDecode(bitmap));
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();

    const secondBitmap = { width: 800, height: 1200, close: vi.fn() } as unknown as ImageBitmap;
    vi.mocked(createImageBitmap).mockResolvedValue(secondBitmap);
    const control = render(<AvatarPhotoControl photo={oldPhoto} onChange={onChange} />);
    await pickPhoto(control.container);
    control.rerender(<AvatarPhotoControl disabled photo={oldPhoto} onChange={onChange} />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Crop photo/i })).toBeNull());
    expect(secondBitmap.close).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("retains the remove action and releases a staged image on unmount", async () => {
    const onChange = vi.fn();
    const control = render(<AvatarPhotoControl photo={oldPhoto} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    expect(onChange).toHaveBeenCalledWith(null);
    await waitFor(() => expect((screen.getByRole("button", { name: "Remove photo" }) as HTMLButtonElement).disabled).toBe(false));
    await pickPhoto(control.container);
    control.unmount();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});

describe("avatar form persistence", () => {
  const coworker: Coworker = {
    id: "coworker-1", name: "Ava", role: "Accounting", description: null, systemPrompt: "Work carefully.",
    modelProvider: "demo", modelName: "faux-1", status: "active", runtimeStatus: "IDLE",
    workspacePath: "/tmp/ava", enabledTools: [], enabledSkillIds: [], isPrimary: false, tags: [],
    policies: {}, sharedFolders: [], avatarImage: oldPhoto, createdAt: "", updatedAt: "",
  };

  function renderSettings(update: ReturnType<typeof vi.fn>) {
    Object.defineProperty(window, "coworker", { configurable: true, value: {
      coworkers: { update },
      memory: { read: vi.fn().mockResolvedValue({ path: "MEMORY.md", content: "", revision: "0".repeat(64) }) },
      integrations: { telegramStatus: vi.fn().mockResolvedValue([]), discordStatus: vi.fn().mockResolvedValue([]) },
    } });
    const onClose = vi.fn();
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const view = render(<CoworkerSettingsModal coworker={coworker} onChanged={onChanged} onClose={onClose} onRemoved={vi.fn()} skills={[]} />);
    return { ...view, onClose, onChanged };
  }

  it("keeps the old photo and crop on a failed save, prevents duplicate saves, and allows retry", async () => {
    let failSave!: (reason: Error) => void;
    const update = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failSave = reject; }))
      .mockResolvedValue({ ...coworker, avatarImage: croppedPhoto });
    const settings = renderSettings(update);
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "Unsaved role" } });
    const dialog = await pickPhoto(settings.container);
    const apply = within(dialog).getByRole("button", { name: "Apply crop" }) as HTMLButtonElement;
    fireEvent.click(apply);
    fireEvent.click(apply);
    expect(update).toHaveBeenCalledExactlyOnceWith(coworker.id, { avatarImage: croppedPhoto });
    expect(screen.getByText("Saving photo…")).toBeTruthy();
    expect(apply.disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(dialog.isConnected).toBe(true);
    expect(settings.onClose).not.toHaveBeenCalled();
    await act(async () => failSave(new Error("Disk full")));
    expect(within(dialog).getByRole("alert").textContent).toContain("Disk full");
    expect(screen.getByRole("img", { name: "Ava avatar" }).querySelector("img")?.getAttribute("src")).toBe(oldPhoto);
    expect(bitmap.close).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Role") as HTMLInputElement).value).toBe("Unsaved role");
    await applyCrop(dialog);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]).toEqual([coworker.id, { avatarImage: croppedPhoto }]);
    expect(screen.getByText("Photo saved")).toBeTruthy();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it("autosaves removal, keeps the photo on failure, and returns focus after retry", async () => {
    const update = vi.fn().mockRejectedValueOnce(new Error("Database unavailable")).mockResolvedValue(coworker);
    const settings = renderSettings(update);
    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Database unavailable");
    expect(screen.getByRole("img", { name: "Ava avatar" }).querySelector("img")?.getAttribute("src")).toBe(oldPhoto);
    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    await screen.findByText("Photo removed");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Upload photo" })));
    expect(update.mock.calls).toEqual([[coworker.id, { avatarImage: null }], [coworker.id, { avatarImage: null }]]);
    expect(screen.queryByRole("button", { name: "Remove photo" })).toBeNull();
    expect(settings.onClose).not.toHaveBeenCalled();
    expect(settings.onChanged).toHaveBeenCalledOnce();
  });

  it("does not autosave a cancelled crop", async () => {
    const update = vi.fn();
    const settings = renderSettings(update);
    const dialog = await pickPhoto(settings.container);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(update).not.toHaveBeenCalled();
    expect(settings.onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("img", { name: "Ava avatar" }).querySelector("img")?.getAttribute("src")).toBe(oldPhoto);
  });

  it("autosaves the crop separately from draft settings and displays it when reopened", async () => {
    const update = vi.fn().mockResolvedValue({ ...coworker, avatarImage: croppedPhoto });
    Object.defineProperty(window, "coworker", { configurable: true, value: {
      coworkers: { update },
      memory: { read: vi.fn().mockResolvedValue({ path: "MEMORY.md", content: "", revision: "0".repeat(64) }) },
      integrations: { telegramStatus: vi.fn().mockResolvedValue([]), discordStatus: vi.fn().mockResolvedValue([]) },
    } });
    const onClose = vi.fn();
    const props = { onChanged: vi.fn().mockResolvedValue(undefined), onClose, onRemoved: vi.fn(), skills: [] };
    const settings = render(<CoworkerSettingsModal coworker={coworker} {...props} />);
    const preview = screen.getByRole("img", { name: "Ava avatar" });
    expect(preview.querySelector("img")?.getAttribute("src")).toBe(oldPhoto);
    expect(document.querySelectorAll(".avatar-picker img")).toHaveLength(1);
    expect(screen.queryByAltText("Uploaded photo preview")).toBeNull();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Draft name" } });
    const dialog = await pickPhoto(settings.container);
    fireEvent.mouseDown(within(dialog).getByRole("button", { name: "Apply crop" }));
    await applyCrop(dialog);
    expect(onClose).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledExactlyOnceWith(coworker.id, { avatarImage: croppedPhoto });
    expect(props.onChanged).toHaveBeenCalledOnce();
    expect(screen.getByText("Photo saved")).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Draft name");
    expect(preview.querySelector("img")?.getAttribute("src")).toBe(croppedPhoto);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Replace photo" })));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]?.[1]).toMatchObject({ name: "Draft name" });
    expect(update.mock.calls[1]?.[1]).not.toHaveProperty("avatarImage");
    settings.unmount();
    render(<CoworkerSettingsModal coworker={{ ...coworker, avatarImage: croppedPhoto }} {...props} />);
    expect(screen.getByRole("img", { name: "Ava avatar" }).querySelector("img")?.getAttribute("src")).toBe(croppedPhoto);
  });

  it("persists a cropped photo when creating a coworker", async () => {
    const create = vi.fn().mockResolvedValue({ ...coworker, avatarImage: croppedPhoto });
    Object.defineProperty(window, "coworker", { configurable: true, value: {
      coworkers: { create },
      integrations: { listModels: vi.fn().mockResolvedValue([{ id: "model", name: "Model", supportsImages: false }]) },
    } });
    const onClose = vi.fn();
    const creation = render(<CreateCoworkerModal settings={{ defaultModelProvider: "openai", defaultModelName: "model" }} onChanged={vi.fn().mockResolvedValue(undefined)} onClose={onClose} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ava" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "Accounting" } });
    const dialog = await pickPhoto(creation.container);
    await applyCrop(dialog);
    expect(create).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create coworker" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ avatarImage: croppedPhoto })));
  });
});
