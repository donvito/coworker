import { Type } from "@earendil-works/pi-ai";
import { maxMessageImages } from "@shared/message-images";

/** Parameters the model sees for each controlled tool, by catalog name. */
export const parameterSchemas: Record<string, ReturnType<typeof Type.Object>> = {
  "skills.read": Type.Object({
    name: Type.String({ description: "Exact name of an enabled skill" }),
    path: Type.Optional(
      Type.String({
        description:
          "Relative packaged resource path. Omit to read skill.md and list available resources.",
      }),
    ),
  }),
  "skills.run": Type.Object({ skill: Type.String(), script: Type.String(), inputs: Type.Array(Type.Object({ root: Type.String(), path: Type.String() })), destination: Type.Object({ root: Type.String(), path: Type.String() }), options: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
  "files.roots": Type.Object({}),
  "coworkers.list": Type.Object({}),
  "coworkers.send_message": Type.Object({
    coworker: Type.String({ description: "Id or exact name of the coworker to message" }),
    message: Type.String({
      description:
        "Self-contained message: the coworker has no access to your conversation, so include the goal, needed context, and the format you want back",
    }),
    expectReply: Type.Optional(
      Type.Boolean({
        description: "Whether their answer should come back to you as a follow-up. Defaults to true.",
      }),
    ),
  }),
  "coworkers.activity": Type.Object({
    coworker: Type.Optional(Type.String({ description: "Id or exact name; omit for everyone" })),
    sinceHours: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 168, description: "Look-back window, default 24" }),
    ),
  }),
  "web.search": Type.Object({
    query: Type.String({ description: "Focused web search query" }),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
    provider: Type.Optional(
      Type.Union([
        Type.Literal("tavily"),
        Type.Literal("exa"),
        Type.Literal("firecrawl"),
        Type.Literal("serpapi"),
      ]),
    ),
    includeImages: Type.Optional(
      Type.Boolean({
        description:
          "Also return an images list (url, title, sourceUrl, and size when known) found for the query. Defaults to false.",
      }),
    ),
  }),
  "chat.attach_images": Type.Object({
    images: Type.Array(
      Type.Object({
        url: Type.String({
          description: "An images[].url value exactly as a tool returned it in this task",
        }),
        alt: Type.String({ description: "Short caption saying what the image shows" }),
      }),
      { minItems: 1, maxItems: maxMessageImages },
    ),
  }),
  "browser.start_session": Type.Object({
    goal: Type.String({ description: "The specific website task the user asked to complete" }),
    startUrl: Type.Optional(
      Type.String({ description: "Optional HTTP or HTTPS page to open first" }),
    ),
  }),
  "browser.inspect": Type.Object({
    pageId: Type.Optional(Type.String({ description: "Page id returned by an earlier browser result" })),
  }),
  "browser.act": Type.Object({
    pageId: Type.Optional(Type.String({ description: "Page id returned by browser.inspect" })),
    action: Type.Union([
      Type.Object({ kind: Type.Literal("navigate"), url: Type.String() }),
      Type.Object({ kind: Type.Literal("back") }),
      Type.Object({ kind: Type.Literal("forward") }),
      Type.Object({ kind: Type.Literal("reload") }),
      Type.Object({ kind: Type.Literal("closePage") }),
      Type.Object({
        kind: Type.Literal("click"),
        target: Type.Object({}, { additionalProperties: true }),
        expectDownload: Type.Optional(Type.Boolean()),
      }),
      Type.Object({
        kind: Type.Literal("fill"),
        target: Type.Object({}, { additionalProperties: true }),
        value: Type.String(),
      }),
      Type.Object({
        kind: Type.Literal("press"),
        target: Type.Object({}, { additionalProperties: true }),
        key: Type.String(),
      }),
      Type.Object({
        kind: Type.Literal("select"),
        target: Type.Object({}, { additionalProperties: true }),
        values: Type.Array(Type.String()),
      }),
      ...["check", "uncheck", "hover"].map((kind) =>
        Type.Object({
          kind: Type.Literal(kind),
          target: Type.Object({}, { additionalProperties: true }),
        }),
      ),
      Type.Object({ kind: Type.Literal("scroll"), deltaY: Type.Number() }),
      Type.Object({ kind: Type.Literal("wait"), milliseconds: Type.Number() }),
      Type.Object({
        kind: Type.Literal("upload"),
        target: Type.Object({}, { additionalProperties: true }),
        paths: Type.Array(Type.String()),
      }),
    ]),
  }),
  "browser.close": Type.Object({}),
  "files.list": Type.Object({
    root: Type.Optional(Type.String({ description: "Root ID from files.roots; defaults to workspace" })),
    path: Type.Optional(Type.String({ description: "Relative directory path; use . for the root" })),
  }),
  "files.read": Type.Object({
    root: Type.Optional(Type.String({ description: "Root ID from files.roots; defaults to workspace" })),
    path: Type.String({ description: "Relative file path inside the coworker workspace" }),
  }),
  "files.write": Type.Object({
    root: Type.Optional(Type.String({ description: "Root ID from files.roots; defaults to workspace" })),
    path: Type.String({ description: "Relative destination path inside the coworker workspace" }),
    content: Type.String({ description: "UTF-8 file contents" }),
    expectedRevision: Type.Optional(Type.String({ description: "Revision from files.read; rejects intervening edits. Required for managed context files." })),
  }),
  "files.edit": Type.Object({
    path: Type.String({ description: "Relative path inside the coworker's workspace." }),
    oldText: Type.String({ description: "Exact, unique existing text to replace. An empty string appends newText." }),
    newText: Type.String({ description: "Replacement or appended text. Empty removes the matched text." }),
    expectedRevision: Type.String({ description: "Revision returned by files.read; rejects intervening changes." }),
  }),
  "folders.list": Type.Object({
    folder: Type.Optional(
      Type.String({
        description:
          "Alias of a granted folder. Omit to list every folder the user granted.",
      }),
    ),
    path: Type.Optional(
      Type.String({ description: "Relative directory path inside the folder; use . for the root" }),
    ),
  }),
  "folders.read": Type.Object({
    folder: Type.String({ description: "Alias of a granted folder from folders.list" }),
    path: Type.String({ description: "Relative file path inside that granted folder" }),
  }),
  "invoice.create": Type.Object({
    root: Type.Optional(Type.String({ description: "Output root ID from files.roots. Omit to use the configured default output folder, or workspace when none is configured. An explicit root overrides the default." })),
    client: Type.String(),
    recipientEmail: Type.Optional(Type.String()),
    lineItems: Type.Array(
      Type.Object({
        description: Type.String(),
        quantity: Type.Number(),
        rate: Type.Number(),
      }),
    ),
    dueDays: Type.Optional(Type.Number()),
    currency: Type.Optional(Type.String()),
    format: Type.Union([
      Type.Literal("pdf"),
      Type.Literal("docx"),
      Type.Literal("markdown"),
      Type.Literal("txt"),
    ], {
      description:
        "The output format explicitly selected by the user. This tool creates that final file directly; do not export it again.",
    }),
  }),
  "documents.export": Type.Object({
    root: Type.Optional(Type.String({ description: "Output root ID from files.roots. Omit to use the configured default output folder, or workspace when none is configured. An explicit root overrides the default." })),
    sourcePath: Type.Optional(Type.String({
      description: "Relative path to an existing Markdown or plain-text workspace file",
    })),
    name: Type.Optional(Type.String({
      description: "Final document base name when creating directly from content",
    })),
    content: Type.Optional(Type.String({
      description:
        "Professionally structured Markdown document content to convert directly without creating an intermediate file. Use #/##/### headings, **bold labels**, lists, tables, and --- dividers as appropriate to the document type.",
    })),
    formats: Type.Array(
      Type.String({
        pattern:
          "^(?:[Pp][Dd][Ff]|[Dd][Oo][Cc][Xx]|[Xx][Ll][Ss][Xx]|[Cc][Ss][Vv]|[Pp][Pp][Tt][Xx])$",
      }),
      {
        description:
          "One or more final output formats (canonical lowercase values pdf, docx, xlsx, csv, or pptx; accepted case-insensitively). For XLSX or CSV, content must include a Markdown table with a descriptive header row and one record per row. CSV supports exactly one table. For PPTX (PowerPoint), the # title becomes the cover slide, each ## heading starts a slide, lists become bullets, and --- forces a slide break.",
        minItems: 1,
        maxItems: 5,
        uniqueItems: true,
      },
    ),
  }),
  "schedules.create": Type.Object({
    name: Type.String({ description: "Short human-readable schedule name" }),
    scheduleType: Type.Union([Type.Literal("cron"), Type.Literal("once")]),
    cronExpression: Type.Optional(
      Type.String({
        description:
          "Five-field cron expression for a recurring schedule, for example 0 9 * * 1 for Mondays at 09:00",
      }),
    ),
    runAt: Type.Optional(
      Type.String({
        description: "ISO 8601 date-time with an offset for a one-time future run",
      }),
    ),
    timezone: Type.Optional(
      Type.String({
        description:
          "IANA timezone such as America/New_York. Omit it to use the user's own timezone, which is the default and needs no confirmation.",
      }),
    ),
    taskTemplate: Type.Object({
      title: Type.String({ description: "Short title for each future task" }),
      input: Type.String({
        description:
          "The work the coworker should perform when the schedule runs. Do not mention creating or managing a schedule.",
      }),
      priority: Type.Optional(Type.Number()),
    }),
    enabled: Type.Optional(Type.Boolean()),
  }),
  "email.create_draft": Type.Object({
    to: Type.Union([Type.String(), Type.Array(Type.String())]),
    subject: Type.String(),
    body: Type.String(),
    attachments: Type.Optional(Type.Array(Type.String())),
  }),
  "email.send": Type.Object({
    to: Type.Union([Type.String(), Type.Array(Type.String())]),
    subject: Type.String(),
    body: Type.String(),
    attachments: Type.Optional(Type.Array(Type.String())),
  }),
  "telegram.send": Type.Object({
    message: Type.String({
      description: "Markdown message to deliver to the user's paired Telegram chat",
    }),
    attachments: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Workspace-relative paths of files to attach. Create the files first; photos up to 10 MB, other files up to 50 MB.",
      }),
    ),
    integrationId: Type.Optional(Type.String({ description: "Connection id from the current request context; required when multiple Telegram connections are available." })),
  }),
  "discord.send": Type.Object({
    message: Type.String({
      description: "Markdown message to deliver to the user's paired Discord channel or thread",
    }),
    attachments: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Workspace-relative paths of files to attach. Create the files first; photos up to 10 MB, other files up to 25 MB.",
      }),
    ),
    integrationId: Type.Optional(Type.String({ description: "Connection id from the current request context; required when multiple Discord connections are available." })),
  }),
};
