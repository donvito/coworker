import { imageRefFromSource } from "@shared/message-images";

/** Attribute on the placeholder that carries one item's image refs. */
export const imageGroupRefsAttribute = "data-image-refs";
export const imageGroupCaptionsAttribute = "data-image-captions";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function refOf(node: HastNode): string | null {
  if (node.type !== "element" || node.tagName !== "img") return null;
  const source = node.properties?.src;
  return imageRefFromSource(typeof source === "string" ? source : undefined);
}

function isSpacing(node: HastNode): boolean {
  return node.type === "text" && !(node.value ?? "").trim();
}

function groupChildren(parent: HastNode): void {
  const children = parent.children;
  if (!children) return;
  const grouped: HastNode[] = [];
  let index = 0;
  while (index < children.length) {
    const node = children[index]!;
    if (!refOf(node)) {
      groupChildren(node);
      grouped.push(node);
      index += 1;
      continue;
    }
    // Refs separated only by spaces belong to the same item.
    const run: HastNode[] = [];
    let end = index;
    while (end < children.length) {
      const candidate = children[end]!;
      if (refOf(candidate)) {
        run.push(candidate);
        end += 1;
      } else if (isSpacing(candidate) && end + 1 < children.length && refOf(children[end + 1]!)) {
        end += 1;
      } else {
        break;
      }
    }
    grouped.push({
      type: "element",
      tagName: "span",
      properties: {
        [imageGroupRefsAttribute]: run.map(refOf).join(" "),
        [imageGroupCaptionsAttribute]: JSON.stringify(
          run.map((image) => {
            const alt = image.properties?.alt;
            return typeof alt === "string" ? alt : "";
          }),
        ),
      },
      children: [],
    });
    index = end;
  }
  parent.children = grouped;
}

/**
 * Rehype plugin: replaces each run of `![caption](image:N)` images that sit
 * side by side with one placeholder, so an item's photos render together.
 */
export function rehypeInlineImageGroups() {
  return (tree: HastNode) => {
    groupChildren(tree);
  };
}

/** Reads a placeholder's refs and captions back from its rendered props. */
export function inlineImageGroupFromProps(
  props: Record<string, unknown>,
): { refs: string[]; captions: string[] } | null {
  const refs = props[imageGroupRefsAttribute];
  if (typeof refs !== "string" || !refs) return null;
  let captions: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(props[imageGroupCaptionsAttribute] ?? "[]"));
    if (Array.isArray(parsed)) captions = parsed.map((caption) => String(caption ?? ""));
  } catch {
    captions = [];
  }
  return { refs: refs.split(" ").filter(Boolean), captions };
}
