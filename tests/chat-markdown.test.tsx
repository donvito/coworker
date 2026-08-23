import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "@renderer/components/ChatMarkdown";

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
});
