import type { ReactNode } from "react";

interface StatusPillProps {
  tone?: "ok" | "info" | "warning" | "danger" | "neutral" | "purple";
  children: ReactNode;
  pulse?: boolean;
}

export function StatusPill({ tone = "neutral", children, pulse = false }: StatusPillProps) {
  return <span className={`status-pill status-pill--${tone}${pulse ? " status-pill--pulse" : ""}`}>{children}</span>;
}
