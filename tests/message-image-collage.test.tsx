// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageAttachmentData } from "@shared/contracts";
import { ChatMarkdown } from "@renderer/components/ChatMarkdown";
import { MessageImageCollage, MessageImageGallery } from "@renderer/components/MessageImageCollage";
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
    ref: `image:${index + 1}`,
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
    const header = dialog.querySelector("figcaption");
    expect(header?.textContent).toContain("Listing 2");
    expect(header?.contains(source)).toBe(true);
    expect(header?.nextElementSibling).toBe(dialog.querySelector("img"));

    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(dialog.textContent).toContain("3 of 3");
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(dialog.textContent).toContain("1 of 3");
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(dialog.textContent).toContain("3 of 3");
    const dot = screen.getByRole("button", { name: "Show image 2: Listing 2" });
    fireEvent.click(dot);
    expect(dialog.textContent).toContain("2 of 3");
    expect(dot.getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(card);
    fireEvent.mouseDown(document.querySelector(".image-lightbox-backdrop")!);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it("keeps showing the open photo when an earlier one finishes loading", async () => {
    let finish!: (value: ImageAttachmentData) => void;
    stubReads((_setId, index) =>
      index === 0 ? new Promise<ImageAttachmentData>((resolve) => (finish = resolve)) : loaded(),
    );
    render(<MessageImageCollage images={images(3)} />);
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "View larger: Listing 3" }));
    const dialog = screen.getByRole("dialog", { name: "Image viewer" });
    const shownTitle = () => dialog.querySelector(".image-lightbox-slide:not([aria-hidden]) .image-lightbox-title")?.textContent;
    expect(shownTitle()).toBe("Listing 3");
    expect(dialog.textContent).toContain("2 of 2");

    finish({ data: pixel, mimeType: "image/png" });
    await waitFor(() => expect(dialog.textContent).toContain("3 of 3"));
    expect(shownTitle()).toBe("Listing 3");
    expect(
      screen.getByRole("button", { name: "Show image 3: Listing 3" }).getAttribute("aria-current"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
    expect(shownTitle()).toBe("Listing 2");
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
    expect(dialog.querySelector(".image-lightbox-title")?.textContent).toContain("<script>");
  });
});

describe("renderer image policy", () => {
  it("keeps remote images blocked by the content security policy", () => {
    const html = readFileSync("src/renderer/index.html", "utf8");
    expect(html).toContain("img-src 'self' data:;");
  });
});

describe("photos placed inside a reply", () => {
  const reply = [
    "| Photo | Listing |",
    "| --- | --- |",
    "| ![Loft photo](image:3) | City loft |",
    "| ![Villa photo](image:1) | Villa |",
    "| ![Invented](image:9) | Not attached |",
    "| ![Remote](https://cdn.example.com/remote.jpg) | Remote |",
  ].join("\n");

  function renderReply() {
    const all = images(3);
    const placed = [all[2]!, all[0]!];
    const collageOnly = [all[1]!];
    return render(
      <MessageImageGallery images={[...placed, ...collageOnly]}>
        <MessageImageCollage images={collageOnly} />
        <ChatMarkdown>{reply}</ChatMarkdown>
      </MessageImageGallery>,
    );
  }

  it("shows placed photos in the reply and only the rest in the collage", async () => {
    const read = stubReads(loaded);
    renderReply();
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(3));

    const cells = [...document.querySelectorAll("td .chat-inline-image")];
    expect(cells.map((cell) => cell.getAttribute("aria-label"))).toEqual([
      "View larger: Loft photo",
      "View larger: Villa photo",
    ]);
    expect(cards().map((card) => card.getAttribute("aria-label"))).toEqual(["View larger: Listing 2"]);
    // Each photo is read once even though two components show them.
    expect(read).toHaveBeenCalledTimes(3);
    // An unknown ref shows nothing; any other address stays text and is never loaded.
    expect(document.body.textContent).toContain("[Image: Remote]");
    expect(document.body.textContent).not.toContain("Invented");
    expect(document.body.innerHTML).not.toContain("cdn.example.com");
  });

  it("opens one carousel over placed and collage photos, in reading order", async () => {
    stubReads(loaded);
    renderReply();
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(3));
    const villa = screen.getByRole("button", { name: "View larger: Villa photo" });

    fireEvent.click(villa);
    const dialog = screen.getByRole("dialog", { name: "Image viewer" });
    expect(dialog.querySelector("img")?.getAttribute("alt")).toBe("Listing 1");
    expect(dialog.textContent).toContain("2 of 3");
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(dialog.querySelector("img")?.getAttribute("alt")).toBe("Listing 2");
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(dialog.querySelector("img")?.getAttribute("alt")).toBe("Listing 3");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "View larger: Loft photo" }),
    );
  });
});

describe("several photos of one item", () => {
  const reply = [
    "| Photos | Listing |",
    "| --- | --- |",
    "| ![Living room](image:1) ![Pool](image:2) ![Bedroom](image:3) | Uptown suite |",
    "| ![Studio](image:4) | Aura suites |",
  ].join("\n");

  function renderGroups(markdown = reply, count = 4) {
    const all = images(count);
    return render(
      <MessageImageGallery images={all}>
        <ChatMarkdown>{markdown}</ChatMarkdown>
      </MessageImageGallery>,
    );
  }

  it("shows refs written side by side as one item's collage", async () => {
    stubReads(loaded);
    renderGroups();
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(4));

    const group = screen.getByRole("group", { name: "3 photos" });
    expect(group.closest("td")).not.toBeNull();
    expect(group.className).toContain("count-3");
    expect([...group.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual([
      "View larger: Living room (1 of 3)",
      "View larger: Pool (2 of 3)",
      "View larger: Bedroom (3 of 3)",
    ]);
    // A lone ref stays a single thumbnail, not a group.
    const single = screen.getByRole("button", { name: "View larger: Studio" });
    expect(single.closest(".chat-inline-image-group")).toBeNull();
  });

  it("opens a carousel of just that item's photos", async () => {
    stubReads(loaded);
    renderGroups();
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(4));

    fireEvent.click(screen.getByRole("button", { name: "View larger: Pool (2 of 3)" }));
    const dialog = screen.getByRole("dialog", { name: "Image viewer" });
    expect(dialog.textContent).toContain("2 of 3");
    expect(dialog.querySelectorAll(".image-lightbox-dots button")).toHaveLength(3);
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(dialog.querySelector("img")?.getAttribute("alt")).toBe("Listing 3");
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(dialog.querySelector("img")?.getAttribute("alt")).toBe("Listing 1");
    fireEvent.keyDown(document, { key: "Escape" });

    // The single photo still opens the whole reply's carousel.
    fireEvent.click(screen.getByRole("button", { name: "View larger: Studio" }));
    expect(screen.getByRole("dialog").textContent).toContain("4 of 4");
  });

  it("shows at most four cards and counts the rest", async () => {
    stubReads(loaded);
    renderGroups("![](image:1) ![](image:2) ![](image:3) ![](image:4) ![](image:5) ![](image:6)", 6);
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(4));
    const group = screen.getByRole("group", { name: "6 photos" });
    expect(group.querySelector(".chat-inline-image-more")?.textContent).toBe("+2");
  });

  it("keeps photos on separate lines or with text between them apart", async () => {
    stubReads(loaded);
    renderGroups("![A](image:1) and ![B](image:2)\n![C](image:3)\n![D](image:4)");
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(4));
    expect(screen.queryByRole("group")).toBeNull();
  });
});
