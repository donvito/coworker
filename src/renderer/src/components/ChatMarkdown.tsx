import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Artifact } from "@shared/contracts";
import { readableError } from "../lib/errors";

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

function ArtifactLink({ artifact, label }: { artifact: Artifact; label: React.ReactNode }) {
  const [status, setStatus] = useState<string | null>(null);

  async function download() {
    setStatus(null);
    try {
      const destination = await window.coworker.artifacts.download(artifact.id);
      if (destination) setStatus("Downloaded");
    } catch (error) {
      setStatus(readableError(error));
    }
  }

  return (
    <>
      <button
        className="chat-markdown-artifact-link"
        onClick={() => void download()}
        title={`Download ${artifact.name}`}
        type="button"
      >
        {label}
      </button>
      {status ? <small className="chat-markdown-artifact-status"> {status}</small> : null}
    </>
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
            if (artifact) return <ArtifactLink artifact={artifact} label={label} />;
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
