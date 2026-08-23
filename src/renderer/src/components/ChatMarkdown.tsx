import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function ChatMarkdown({ children }: { children: string }) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: label, href }) => (
            <a href={href} rel="noreferrer" target="_blank">
              {label}
            </a>
          ),
          img: ({ alt }) => <span className="chat-markdown-image-note">[Image: {alt || "image"}]</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
