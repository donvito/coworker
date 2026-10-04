// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { avatarCropFor, avatarCropToDataUrl, loadAvatarPhoto } from "@renderer/lib/avatar-image";
import { avatarImageSchema } from "@shared/validation";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("avatar crop geometry", () => {
  it("starts centered for portrait, landscape, and square photos", () => {
    expect(avatarCropFor(1200, 800, 1)).toEqual({ x: 200, y: 0, size: 800 });
    expect(avatarCropFor(800, 1200, 1)).toEqual({ x: 0, y: 200, size: 800 });
    expect(avatarCropFor(800, 800, 1)).toEqual({ x: 0, y: 0, size: 800 });
  });

  it("zooms around the chosen center and clamps movement at each edge", () => {
    expect(avatarCropFor(1200, 800, 2, { x: 900, y: 300 }))
      .toEqual({ x: 700, y: 100, size: 400 });
    expect(avatarCropFor(1200, 800, 2, { x: -1000, y: -1000 }))
      .toEqual({ x: 0, y: 0, size: 400 });
    expect(avatarCropFor(1200, 800, 2, { x: 10000, y: 10000 }))
      .toEqual({ x: 800, y: 400, size: 400 });
  });

  it("constrains zoom to 1–3 and always keeps the crop inside the image", () => {
    expect(avatarCropFor(900, 600, 0.5).size).toBe(600);
    expect(avatarCropFor(900, 600, 10).size).toBe(200);
    for (const [width, height] of [[600, 900], [900, 600], [800, 800], [1, 10000]]) {
      for (const zoom of [1, 1.01, 1.5, 2, 3]) {
        for (const center of [{ x: -10000, y: -10000 }, { x: 500, y: 500 }, { x: 10000, y: 10000 }]) {
          const crop = avatarCropFor(width!, height!, zoom, center);
          expect(crop.x).toBeGreaterThanOrEqual(0);
          expect(crop.y).toBeGreaterThanOrEqual(0);
          expect(crop.size).toBeGreaterThan(0);
          expect(crop.x + crop.size).toBeLessThanOrEqual(width!);
          expect(crop.y + crop.size).toBeLessThanOrEqual(height!);
        }
      }
    }
  });

  it("rejects invalid geometry rather than returning a blank crop", () => {
    for (const dimensions of [[0, 500], [-1, 500], [500, 0], [NaN, 500], [500, Infinity]]) {
      expect(() => avatarCropFor(dimensions[0]!, dimensions[1]!, 1)).toThrow();
    }
    expect(() => avatarCropFor(500, 500, NaN)).toThrow();
    expect(() => avatarCropFor(500, 500, Infinity)).toThrow();
    expect(() => avatarCropFor(500, 500, 1, { x: NaN, y: 0 })).toThrow();
  });
});

describe("local avatar image processing", () => {
  it("decodes accepted photos without writing or retaining the original", async () => {
    const bitmap = { width: 1200, height: 800, close: vi.fn() } as unknown as ImageBitmap;
    const decode = vi.fn().mockResolvedValue(bitmap);
    vi.stubGlobal("createImageBitmap", decode);
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      const file = new File(["photo"], "photo", { type });
      expect(await loadAvatarPhoto(file)).toBe(bitmap);
      expect(decode.mock.calls.at(-1)?.[0]).toBe(file);
    }
  });

  it("rejects unsupported and oversized files before decoding", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    await expect(loadAvatarPhoto(new File(["svg"], "photo.svg", { type: "image/svg+xml" })))
      .rejects.toThrow(/PNG.*JPEG.*WebP/);
    await expect(loadAvatarPhoto(new File([new Uint8Array(10 * 1024 * 1024 + 1)], "photo.png", { type: "image/png" })))
      .rejects.toThrow(/10 MB/);
    expect(decode).not.toHaveBeenCalled();
  });

  it("reports unreadable images and releases an invalid decoded bitmap", async () => {
    const decode = vi.fn().mockRejectedValue(new Error("decoder failed"));
    vi.stubGlobal("createImageBitmap", decode);
    const file = new File(["corrupt"], "photo.jpg", { type: "image/jpeg" });
    await expect(loadAvatarPhoto(file)).rejects.toThrow(/could not be read/);
    const close = vi.fn();
    decode.mockResolvedValue({ width: 0, height: 800, close });
    await expect(loadAvatarPhoto(file)).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });

  it("exports exactly the selected source rectangle at 256×256 as a valid JPEG", () => {
    const drawImage = vi.fn();
    const fillRect = vi.fn();
    const context = { drawImage, fillRect, fillStyle: "" };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
    const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(jpeg);
    const bitmap = { width: 1200, height: 800, close: vi.fn() } as unknown as ImageBitmap;
    const crop = { x: 700, y: 100, size: 400 };
    expect(avatarImageSchema.parse(avatarCropToDataUrl(bitmap, crop))).toBe(jpeg);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 700, 100, 400, 400, 0, 0, 256, 256);
    expect(context.fillStyle).toBe("#ffffff");
    expect(fillRect).toHaveBeenCalledWith(0, 0, 256, 256);
    expect(fillRect.mock.invocationCallOrder[0]).toBeLessThan(drawImage.mock.invocationCallOrder[0]!);
    expect(encode).toHaveBeenCalledWith("image/jpeg", 0.85);
    const canvas = encode.mock.instances[0] as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([256, 256]);
    // The editor owns the source lifetime so an export error can be retried.
    expect(bitmap.close).not.toHaveBeenCalled();
  });

  it("rejects empty or out-of-bounds crops before drawing", () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    const bitmap = { width: 800, height: 600 } as ImageBitmap;
    for (const crop of [
      { x: -1, y: 0, size: 100 }, { x: 0, y: 0, size: 0 },
      { x: 700, y: 0, size: 200 }, { x: 0, y: 500, size: 200 },
      { x: NaN, y: 0, size: 100 },
    ]) expect(() => avatarCropToDataUrl(bitmap, crop)).toThrow();
    expect(getContext).not.toHaveBeenCalled();
  });

  it("reports unavailable processing and malformed or oversized output", () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const bitmap = { width: 800, height: 600 } as ImageBitmap;
    const crop = avatarCropFor(800, 600, 1);
    expect(() => avatarCropToDataUrl(bitmap, crop)).toThrow(/unavailable/);
    getContext.mockReturnValue({ drawImage: vi.fn(), fillRect: vi.fn() } as never);
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL");
    for (const output of ["data:,", "data:image/jpeg;base64,bad!", `data:image/jpeg;base64,${"A".repeat(150_000)}`]) {
      encode.mockReturnValue(output);
      expect(() => avatarCropToDataUrl(bitmap, crop)).toThrow();
    }
  });
});
