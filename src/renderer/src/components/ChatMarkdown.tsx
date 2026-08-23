import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Artifact } from "@shared/contracts";
import { ArtifactActions, artifactExtension, artifactKind } from "./ArtifactActions";
import { Icon } from "./Icon";
import { formatRelativeTime } from "./Primitives";

const browsableSchemes = ["http:", "https:", "mailto:"];

function isBrowsable(href: string): boolean {
  return browsableSchemes.some((scheme) => href.toLowerCase().startsWith(scheme));
}

/**
 * Models often advertise a file they wrote with a link they invented, such as
 * `sandbox:/mnt/data/report.csv` or a bare workspace path. Those hrefs point
 * nowhere in the app, so match them back to a real artifact by file name.
 */
function matchArtifact(href: string, artifacts: Artifact[]): Artifact | undefined {
  if (isBrowsable(href)) return undefined;
  const name = decodeURIComponent(href.split(/[?#]/)[0] ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    ?.toLowerCase();
  if (!name) return undefined;
  return artifacts.find((artifact) => artifact.name.toLowerCase() === name);
}

/**
 * Rendered in place of the link, so a created file reads as a file — name,
 * kind, and the same Open/Download actions as the Files panel. Built from
 * inline elements because Markdown drops it inside a paragraph.
 */
function ChatArtifactCard({ artifact }: { artifact: Artifact }) {
  return (
    <span className="chat-artifact-card">
      <span className="chat-artifact-icon">
        <Icon name="file" />
        <small>{artifactExtension(artifact)}</small>
      </span>
      <span className="chat-artifact-copy">
        <strong title={artifact.name}>{artifact.name}</strong>
        <small>
          {artifactKind(artifact)} · {formatRelativeTime(artifact.createdAt)}
        </small>
        <ArtifactActions target={{ id: artifact.id, name: artifact.name }} />
      </span>
    </span>
  );
}

export function ChatMarkdown({
  children,
  artifacts = [],
}: {
  children: string;
  artifacts?: Artifact[];
}) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Keep the raw href so invented `sandbox:` links can be matched to an
        // artifact; only http(s)/mailto ever reach an anchor below.
        urlTransform={(url) => url}
        components={{
          a: ({ children: label, href }) => {
            const artifact = href ? matchArtifact(href, artifacts) : undefined;
            if (artifact) return <ChatArtifactCard artifact={artifact} />;
            if (!href || !isBrowsable(href)) {
              return <span className="chat-markdown-dead-link">{label}</span>;
            }
            return (
              <a href={href} rel="noreferrer" target="_blank">
                {label}
              </a>
            );
          },
          img: ({ alt }) => <span className="chat-markdown-image-note">[Image: {alt || "image"}]</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
