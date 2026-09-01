import type { IconName } from "./Icon";
import { Icon } from "./Icon";

interface KpiCardProps {
  label: string;
  value: string | number;
  detail: string;
  icon: IconName;
  tone?: "default" | "warning" | "danger" | "purple";
  trend?: string;
}

export function KpiCard({ label, value, detail, icon, tone = "default", trend }: KpiCardProps) {
  return (
    <article className={`kpi-card kpi-card--${tone}`}>
      <div className="kpi-card__top">
        <span>{label}</span>
        <span className="kpi-card__icon"><Icon name={icon} size={17} /></span>
      </div>
      <div className="kpi-card__value-row">
        <strong>{value}</strong>
        {trend && <span className="kpi-card__trend">{trend}</span>}
      </div>
      <p>{detail}</p>
    </article>
  );
}
