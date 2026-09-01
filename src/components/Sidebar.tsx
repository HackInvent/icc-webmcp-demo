import type { RailSnapshot } from "../rail/domain";
import type { DetailType, PageKey } from "../navigation";
import { navigate, pathForPage } from "../navigation";
import { Icon, type IconName } from "./Icon";

interface SidebarProps {
  currentPage: PageKey;
  currentDetailType?: DetailType;
  snapshot: RailSnapshot;
  collapsed: boolean;
  onToggle: () => void;
}

interface NavItem {
  page: Exclude<PageKey, "detail">;
  label: string;
  helper: string;
  icon: IconName;
  badge?: number;
  tone?: "warning" | "danger";
}

export function Sidebar({ currentPage, currentDetailType, snapshot, collapsed, onToggle }: SidebarProps) {
  const detailParent: Exclude<PageKey, "detail"> =
    currentDetailType === "driver"
      ? "schedules"
      : currentDetailType === "incident"
        ? "incidents"
        : currentDetailType === "power"
          ? "power"
          : currentDetailType === "train"
            ? "regulation"
            : "overview";
  const items: NavItem[] = [
    { page: "overview", label: "Network overview", helper: "Metropolitan operations", icon: "network" },
    { page: "passenger-flow", label: "Passenger flow", helper: "Station pressure heatmap", icon: "users" },
    {
      page: "schedules",
      label: "Schedules & drivers",
      helper: "D-1 service plan",
      icon: "calendar",
      badge: snapshot.drivers.filter((driver) => driver.status === "relief-risk").length,
      tone: "warning",
    },
    {
      page: "incidents",
      label: "Incident management",
      helper: "Assess, decide, document",
      icon: "alert",
      badge: snapshot.incidents.filter((incident) => incident.status === "active").length,
      tone: "danger",
    },
    {
      page: "regulation",
      label: "Delays & regulation",
      helper: "Headways and conflicts",
      icon: "activity",
      badge: snapshot.trains.filter((train) => train.delaySeconds >= 300).length,
      tone: "warning",
    },
    {
      page: "power",
      label: "Traction power",
      helper: "Sections and substations",
      icon: "bolt",
      badge: snapshot.powerSections.filter((section) => section.status !== "energized").length,
      tone: "warning",
    },
    { page: "scada", label: "SCADA architecture", helper: "Field, ATS & passenger systems", icon: "layers" },
    { page: "buses", label: "Bus services", helper: "Continuity & shuttle operations", icon: "bus" },
    { page: "rolling-stock", label: "Rolling stock", helper: "Capacity, load & energy", icon: "train" },
    { page: "procedures", label: "Procedures", helper: "Versioned response documents", icon: "shield" },
    {
      page: "log",
      label: "Operations log",
      helper: "Timestamped shift evidence",
      icon: "activity",
    },
    {
      page: "report",
      label: "Shift report",
      helper: "Draft, freeze and print",
      icon: "shield",
    },
  ];

  return (
    <aside id="text-text-global-sidebar" className={`sidebar${collapsed ? " sidebar--collapsed" : ""}`}>
      <div className="sidebar__brand" id="text-text-global-brand">
        <div className="brand-mark"><span>P</span><span>ICC</span></div>
        {!collapsed && <div><strong>Paris ICC - WebMCP DEMO</strong><small>Operations decision canvas</small></div>}
      </div>

      <div className="sidebar__scope" id="text-text-global-scope">
        {!collapsed && <span>Active scope</span>}
        <div className="scope-selector" aria-label="Active scope: Metro and RER">
          <span className="scope-selector__dot" />
          {!collapsed && <span>Metro + RER</span>}
        </div>
      </div>

      <nav className="sidebar__nav" id="text-text-global-navigation" aria-label="Main navigation">
        {!collapsed && <p className="sidebar__eyebrow">OPERATIONS WORKSPACE</p>}
        {items.map((item) => {
          const selected = currentPage === item.page || (currentPage === "detail" && item.page === detailParent);
          return (
            <button
              type="button"
              key={item.page}
              className={`nav-item${selected ? " nav-item--active" : ""}`}
              onClick={() => navigate(pathForPage(item.page))}
              aria-label={item.label}
              aria-current={selected ? "page" : undefined}
              title={collapsed ? item.label : undefined}
            >
              <span className="nav-item__icon"><Icon name={item.icon} size={19} /></span>
              {!collapsed && <span className="nav-item__copy"><strong>{item.label}</strong><small>{item.helper}</small></span>}
              {!!item.badge && <span className={`nav-item__badge nav-item__badge--${item.tone ?? "warning"}`}>{item.badge}</span>}
            </button>
          );
        })}
      </nav>

      <div className="sidebar__bottom" id="text-text-global-safety-and-collapse">
        {!collapsed && (
          <div className="safety-card">
            <Icon name="shield" size={17} />
            <div><strong>Decision-support mode</strong><span>Human approval · no field commands</span></div>
          </div>
        )}
        <button type="button" className="collapse-button" onClick={onToggle} aria-label={collapsed ? "Expand menu" : "Collapse menu"}>
          <Icon name="panel" size={18} />
          {!collapsed && <span>Collapse menu</span>}
        </button>
      </div>
    </aside>
  );
}
