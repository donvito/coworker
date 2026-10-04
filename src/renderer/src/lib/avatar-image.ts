import { avatarImageSchema } from "../../../shared/validation";

const outputSize = 256;
const maxSourceBytes = 10 * 1024 * 1024;
const acceptedTypes = ["image/png", "image/jpeg", "image/webp"];

export type AvatarCrop = { x: number; y: number; size: number };

export const avatarPhotoAccept = acceptedTypes.join(",");
export const avatarPhotoBackground = "#ffffff";

/** Return a square crop around a source-pixel center, bounded to the bitmap. */
export function avatarCropFor(
  width: number,
  height: number,
  zoom: number,
  center: { x: number; y: number } = { x: width / 2, y: height / 2 },
): AvatarCrop {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error("Image dimensions must be finite and greater than zero.");
  }
  if (!Number.isFinite(zoom)) throw new Error("Zoom must be a finite number.");
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) {
    throw new Error("Crop position must use finite coordinates.");
  }
  const boundedZoom = Math.max(1, Math.min(3, zoom));
  const size = Math.min(width, height) / boundedZoom;
  const x = Math.max(0, Math.min(width - size, center.x - size / 2));
  const y = Math.max(0, Math.min(height - size, center.y - size / 2));
  return { x, y, size };
}

/** Decode and validate an uploaded avatar while retaining its source pixels for cropping. */
export async function loadAvatarPhoto(file: File): Promise<ImageBitmap> {
  if (!acceptedTypes.includes(file.type)) throw new Error("Choose a PNG, JPEG, or WebP photo.");
  if (file.size > maxSourceBytes) throw new Error("That photo is larger than 10 MB.");
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That image could not be read.");
  });
  if (!Number.isFinite(bitmap.width) || bitmap.width <= 0 || !Number.isFinite(bitmap.height) || bitmap.height <= 0) {
    bitmap.close();
    throw new Error("That image has invalid dimensions.");
  }
  return bitmap;
}

/** Render a bounded source-pixel crop to the app's validated avatar JPEG format. */
export function avatarCropToDataUrl(bitmap: ImageBitmap, crop: AvatarCrop): string {
  if (!Number.isFinite(bitmap.width) || bitmap.width <= 0 || !Number.isFinite(bitmap.height) || bitmap.height <= 0) {
    throw new Error("Image dimensions must be finite and greater than zero.");
  }
  if (
    !Number.isFinite(crop.x) || !Number.isFinite(crop.y) || !Number.isFinite(crop.size) || crop.size <= 0 ||
    crop.x < 0 || crop.y < 0 || crop.x + crop.size > bitmap.width || crop.y + crop.size > bitmap.height
  ) {
    throw new Error("The crop area is outside the image.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image processing is unavailable.");
  context.fillStyle = avatarPhotoBackground;
  context.fillRect(0, 0, outputSize, outputSize);
  context.drawImage(bitmap, crop.x, crop.y, crop.size, crop.size, 0, 0, outputSize, outputSize);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  const parsed = avatarImageSchema.safeParse(dataUrl);
  if (!parsed.success || !dataUrl.startsWith("data:image/jpeg;base64,")) {
    throw new Error("The cropped photo could not be saved. Try another photo.");
  }
  return dataUrl;
}
