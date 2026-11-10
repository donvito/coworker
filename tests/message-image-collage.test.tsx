// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageAttachmentData } from "@shared/contracts";
import { MessageImageCollage } from "@renderer/components/MessageImageCollage";
import type { PlacedMessageImage } from "../src/renderer/src/lib/message-image-placement";

afterEach(cleanup);

const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function images(count: number): PlacedMessageImage[] {
  return Array.from({ length: count }, (_, index) => ({
    setId: "set-1",
    index,
    url: `https://cdn.example.com/${index}.jpg`,
    alt: `Listing ${index + 1}`,
    sourceUrl: `https://stays.example.com/rooms/${index + 1}`,
    width: 1200,
    height: 800,
  }));
}

function stubReads(read: (setId: string, index: number) => Promise<ImageAttachmentData>) {
  const spy = vi.fn(read);
  Object.defineProperty(window, "coworker", {
    configurable: true,
    value: { messageImages: { read: spy } },
  });
  return spy;
}

const loaded = async (): Promise<ImageAttachmentData> => ({ data: pixel, mimeType: "image/png" });
const collage = () => document.querySelector(".message-image-collage");
const cards = () => [...document.querySelectorAll(".message-image-card")];

describe("message image collage", () => {
  it.each([1, 2, 3, 6])("lays out %i image(s) as cards", async (count) => {
    const read = stubReads(loaded);
    render(<MessageImageCollage images={images(count)} />);

    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(count));
    expect(collage()?.className).toBe(`message-image-collage count-${count}`);
    expect(read).toHaveBeenCalledTimes(count);
    expect(read).toHaveBeenCalledWith("set-1", count - 1);
    for (const image of screen.getAllByRole("img")) {
      expect(image.getAttribute("src")).toBe(`data:image/png;base64,${pixel}`);
    }
  });

  it("never points an element at the remote address", async () => {
    stubReads(loaded);
    render(<MessageImageCollage images={images(2)} />);
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(2));
    expect(document.body.innerHTML).not.toContain("cdn.example.com");
  });

  it("shows placeholders while images are slow, then the images", async () => {
    let finish!: (value: ImageAttachmentData) => void;
    stubReads((_setId, index) =>
      index === 0 ? loaded() : new Promise<ImageAttachmentData>((resolve) => (finish = resolve)),
    );
    render(<MessageImageCollage images={images(2)} />);

    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(1));
    expect(screen.getByRole("img", { name: "Loading image: Listing 2" }).className).toContain("loading");
    expect(collage()?.className).toContain("count-2");

    finish({ data: pixel, mimeType: "image/png" });
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(2));
    expect(screen.queryByRole("img", { name: "Loading image: Listing 2" })).toBeNull();
  });

  it("drops images that cannot be loaded and re-lays out the rest", async () => {
    stubReads((_setId, index) => (index === 1 ? Promise.reject(new Error("404")) : loaded()));
    render(<MessageImageCollage images={images(3)} />);

    await waitFor(() => expect(collage()?.className).toContain("count-2"));
    expect(cards()).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "View larger: Listing 2" })).toBeNull();
  });

  it("drops an image whose bytes do not decode", async () => {
    stubReads(loaded);
    render(<MessageImageCollage images={images(2)} />);
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(2));

    fireEvent.error(screen.getByRole("img", { name: "Listing 1" }));
    await waitFor(() => expect(collage()?.className).toContain("count-1"));
  });

  it("renders nothing when every image fails", async () => {
    stubReads(() => Promise.reject(new Error("offline")));
    const view = render(<MessageImageCollage images={images(2)} />);
    await waitFor(() => expect(view.container.innerHTML).toBe(""));
  });

  it("opens a larger view with caption and source, steps through images, and closes", async () => {
    stubReads(loaded);
    render(<MessageImageCollage images={images(3)} />);
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(3));
    const card = screen.getByRole("button", { name: "View larger: Listing 2" });

    fireEvent.click(card);
    const dialog = screen.getByRole("dialog", { name: "Image viewer" });
    expect(dialog.querySelector("img")?.getAttribute("alt")).toBe("Listing 2");
    expect(dialog.textContent).toContain("2 of 3");
    const source = dialog.querySelector("a");
    expect(source?.getAttribute("href")).toBe("https://stays.example.com/rooms/2");
    expect(source?.getAttribute("target")).toBe("_blank");
    expect(source?.getAttribute("rel")).toBe("noreferrer");
    expect(source?.textContent).toContain("stays.example.com");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close image" }));

    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(dialog.textContent).toContain("3 of 3");
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(dialog.textContent).toContain("1 of 3");
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(dialog.textContent).toContain("3 of 3");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(card);
    fireEvent.mouseDown(document.querySelector(".image-lightbox-backdrop")!);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it("shows captions as text and omits a source that is not HTTPS", async () => {
    stubReads(loaded);
    const [image] = images(1);
    render(
      <MessageImageCollage
        images={[
          {
            ...image!,
            alt: '<img src=x onerror="alert(1)"><script>alert(2)</script>',
            sourceUrl: "javascript:alert(3)",
          },
        ]}
      />,
    );
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button"));

    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("script")).toBeNull();
    expect(dialog.querySelectorAll("img")).toHaveLength(1);
    expect(dialog.querySelector("a")).toBeNull();
    expect(dialog.querySelector(".image-lightbox-caption")?.textContent).toContain("<script>");
  });
});

describe("renderer image policy", () => {
  it("keeps remote images blocked by the content security policy", () => {
    const html = readFileSync("src/renderer/index.html", "utf8");
    expect(html).toContain("img-src 'self' data:;");
  });
});
