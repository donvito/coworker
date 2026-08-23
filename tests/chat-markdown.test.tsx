import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Artifact } from "@shared/contracts";
import { ChatMarkdown } from "@renderer/components/ChatMarkdown";

const csv: Artifact = {
  id: "artifact-1",
  taskId: null,
  coworkerId: "coworker-1",
  name: "seedance_2_5_profiles.csv",
  mimeType: "text/csv",
  filePath: "/workspace/seedance_2_5_profiles.csv",
  createdAt: new Date().toISOString(),
};

describe("coworker response Markdown", () => {
  it("renders common Markdown and does not execute raw HTML", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{`# Result

- one
- two

| Name | Value |
| --- | --- |
| Status | **Ready** |

\`inline\`

<script>alert('unsafe')</script>`}</ChatMarkdown>,
    );

    expect(html).toContain("<h1>Result</h1>");
    expect(html).toContain("<table>");
    expect(html).toContain("<strong>Ready</strong>");
    expect(html).toContain("<code>inline</code>");
    expect(html).not.toContain("<script>");
  });

  it("turns an invented file link into a download for the matching artifact", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown artifacts={[csv]}>
        {"[Download the CSV](sandbox:/mnt/data/seedance_2_5_profiles.csv)"}
      </ChatMarkdown>,
    );

    expect(html).toContain('class="chat-markdown-artifact-link"');
    expect(html).toContain("Download the CSV");
    expect(html).not.toContain("sandbox:/mnt/data");
  });

  it("does not render an unusable link as a clickable anchor", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown artifacts={[]}>{"[Download the CSV](sandbox:/mnt/data/other.csv)"}</ChatMarkdown>,
    );

    expect(html).not.toContain("<a ");
    expect(html).toContain("Download the CSV");
  });

  it("keeps ordinary web links clickable", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown artifacts={[csv]}>{"[Docs](https://example.com/docs)"}</ChatMarkdown>,
    );

    expect(html).toContain('href="https://example.com/docs"');
  });

  it("never renders a javascript: link as an anchor", () => {
    const html = renderToStaticMarkup(
      // eslint-disable-next-line no-script-url
      <ChatMarkdown artifacts={[]}>{"[Click me](javascript:alert(1))"}</ChatMarkdown>,
    );

    expect(html).not.toContain("<a ");
    expect(html).not.toContain("javascript:");
  });
});
