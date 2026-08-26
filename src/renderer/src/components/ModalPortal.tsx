import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Renders modal layers on document.body. Pages animate with transforms, and a
 * filled transform animation keeps the page as the containing block for
 * position: fixed, which would otherwise clip modal backdrops to the page.
 */
export function ModalPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
