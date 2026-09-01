import type { ReactNode } from "react";

interface PageHeaderProps {
  contentId: `text-text-${string}`;
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}

export function PageHeader({ contentId, eyebrow, title, description, actions }: PageHeaderProps) {
  return (
    <div className="page-header" id={contentId}>
      <div><span className="page-header__eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </div>
  );
}
