import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

interface ModalProps {
  contentId: `text-text-${string}`;
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  workspace?: boolean;
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

export function Modal({ contentId, title, eyebrow, onClose, children, footer, wide = false, workspace = false }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    const dialog = dialogRef.current;
    const backdrop = dialog?.parentElement;
    const appRoot = backdrop?.parentElement;
    const background = appRoot
      ? Array.from(appRoot.children)
        .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
        .map((element) => ({
          element,
          inert: element.inert,
          ariaHidden: element.getAttribute("aria-hidden"),
        }))
      : [];

    document.body.style.overflow = "hidden";
    for (const item of background) {
      item.element.inert = true;
      item.element.setAttribute("aria-hidden", "true");
    }

    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      const backdrops = Array.from(document.querySelectorAll(".modal-backdrop"));
      if (backdrops.at(-1) !== dialogRef.current?.parentElement) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      for (const item of background) {
        item.element.inert = item.inert;
        if (item.ariaHidden === null) item.element.removeAttribute("aria-hidden");
        else item.element.setAttribute("aria-hidden", item.ariaHidden);
      }
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <div
      id={`${contentId}-backdrop`}
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        id={contentId}
        ref={dialogRef}
        className={`modal${wide ? " modal--wide" : ""}${workspace ? " modal--workspace" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="modal__header" id={`${contentId}-header`}>
          <div>{eyebrow && <span className="modal__eyebrow">{eyebrow}</span>}<h2 id={titleId}>{title}</h2></div>
          <button ref={closeButtonRef} type="button" className="icon-button" onClick={onClose} aria-label="Close dialog"><Icon name="close" size={19} /></button>
        </header>
        <div className="modal__body" id={`${contentId}-body`}>{children}</div>
        {footer && <footer className="modal__footer" id={`${contentId}-footer`}>{footer}</footer>}
      </section>
    </div>
  );
}
