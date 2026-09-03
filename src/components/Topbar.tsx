import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { pathForPage, type PageKey } from "../navigation";
import type { EntitySelection, RailSnapshot, SimulationState } from "../rail/domain";
import { STEP_MS } from "../rail/simulation";
import { scheduleWorkspace } from "../schedules/workspace";
import { formatParisOperationalTime } from "../rail/operationalTime";
import { Icon } from "./Icon";
import { StatusPill } from "./StatusPill";

interface TopbarProps {
  currentPage: PageKey;
  snapshot: RailSnapshot;
  speed: SimulationState["speed"];
  setSpeed: (speed: SimulationState["speed"]) => void;
  onSelect: (selection: EntitySelection) => void;
  onSource: () => void;
  onConfiguration: () => void;
  configurationOpen: boolean;
  onReset: () => void;
  onSignOut?: () => void | Promise<void>;
}

interface SearchResult extends EntitySelection {
  title: string;
  meta: string;
}

function formatOperationalTime(timestamp: number): string {
  return formatParisOperationalTime(timestamp, true);
}

function formatOperationalDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(timestamp);
}

export function Topbar({ currentPage, snapshot, speed, setSpeed, onSelect, onSource, onConfiguration, configurationOpen, onReset, onSignOut }: TopbarProps) {
  const stepSeconds = STEP_MS / 1_000;
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchInput = useRef<HTMLInputElement>(null);
  const scheduleState = useSyncExternalStore(
    scheduleWorkspace.subscribe,
    scheduleWorkspace.getSnapshot,
    scheduleWorkspace.getSnapshot,
  );
  const schedulePlan = scheduleWorkspace.currentPlan();
  const feed = snapshot.passengerFeed;
  const sourceLabel = feed?.mode === "prim-live"
    ? "Passenger · PRIM live"
    : feed?.mode === "prim-replay"
      ? "Passenger · PRIM replay"
      : "Operational state";
  const sourceStatus = feed?.mode === "prim-live"
    ? feed.status
    : feed?.mode === "prim-replay"
      ? "SIRI contract"
      : "Operational context";

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const results = useMemo<SearchResult[]>(() => {
    const normalized = query.trim().toLowerCase();
    if (normalized.length < 2) return [];
    const all: SearchResult[] = [
      ...snapshot.trains.map((train) => ({ type: "train" as const, id: train.id, title: train.id, meta: `${train.circulationId} · ${train.nextStop}` })),
      ...snapshot.circuits.map((circuit) => ({ type: "circuit" as const, id: circuit.id, title: circuit.id, meta: `${circuit.fromStation} → ${circuit.toStation}` })),
      ...snapshot.drivers.map((driver) => ({ type: "driver" as const, id: driver.id, title: driver.id, meta: `${driver.depot} · ${driver.status}` })),
      ...snapshot.incidents.map((incident) => ({ type: "incident" as const, id: incident.id, title: incident.id, meta: incident.title })),
      ...snapshot.powerSections.map((section) => ({ type: "power" as const, id: section.id, title: section.id, meta: section.name })),
      ...schedulePlan.services
        .filter((service) => service.trainId !== null && snapshot.trains.some((train) => train.id === service.trainId))
        .map((service) => ({
          type: "train" as const,
          id: service.trainId!,
          title: service.serviceId,
          meta: `${service.circulationId} · ${service.origin} → ${service.destination}`,
        })),
    ];
    return all.filter((result) => `${result.title} ${result.meta}`.toLowerCase().includes(normalized)).slice(0, 6);
  }, [query, snapshot, scheduleState]);

  return (
    <header className="topbar" id="text-text-global-header">
      <div
        id="text-text-global-search"
        className="global-search"
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setFocused(false);
            setActiveIndex(-1);
          }
        }}
      >
        <Icon name="search" size={18} />
        <input
          ref={searchInput}
          value={query}
          role="combobox"
          aria-label="Global search"
          aria-autocomplete="list"
          aria-expanded={focused && results.length > 0}
          aria-controls="global-search-results"
          aria-activedescendant={activeIndex >= 0 ? `global-search-option-${activeIndex}` : undefined}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(-1);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && results.length > 0) {
              event.preventDefault();
              setActiveIndex((index) => (index + 1) % results.length);
            } else if (event.key === "ArrowUp" && results.length > 0) {
              event.preventDefault();
              setActiveIndex((index) => (index <= 0 ? results.length - 1 : index - 1));
            } else if (event.key === "Enter" && activeIndex >= 0) {
              event.preventDefault();
              const result = results[activeIndex];
              if (result) {
                onSelect(result);
                setQuery("");
                setFocused(false);
                setActiveIndex(-1);
              }
            } else if (event.key === "Escape") {
              event.preventDefault();
              setQuery("");
              setFocused(false);
              setActiveIndex(-1);
              event.currentTarget.blur();
            }
          }}
          placeholder="Search operations…"
        />
        <kbd aria-hidden="true">⌘/Ctrl K</kbd>
        {focused && results.length > 0 && (
          <div className="search-results" id="global-search-results" role="listbox">
            {results.map((result, index) => (
              <button
                type="button"
                role="option"
                id={`global-search-option-${index}`}
                aria-selected={activeIndex === index}
                key={`${result.type}-${result.id}-${result.title}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => {
                  onSelect(result);
                  setQuery("");
                  setFocused(false);
                  setActiveIndex(-1);
                }}
              >
                <span><strong>{result.title}</strong><small>{result.meta}</small></span>
                <Icon name="chevron" size={15} />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="topbar__controls" id="text-text-global-controls">
        <a
          className={"simview-link" + (currentPage === "procedures" ? " simview-link--active" : "")}
          href={"#" + pathForPage("procedures")}
          aria-current={currentPage === "procedures" ? "page" : undefined}
        >
          <Icon name="shield" size={16} />
          <span>Procedures</span>
        </a>
        <a
          className={"simview-link" + (currentPage === "simulator" ? " simview-link--active" : "")}
          href={"#" + pathForPage("simulator")}
          aria-current={currentPage === "simulator" ? "page" : undefined}
        >
          <Icon name="panel" size={16} />
          <span>SimView</span>
        </a>

        <button
          type="button"
          className="simview-link configuration-trigger"
          id="text-text-global-configuration"
          data-testid="open-configuration"
          onClick={onConfiguration}
          aria-haspopup="dialog"
          aria-label="Open application configuration"
          aria-expanded={configurationOpen}
          aria-controls="text-text-modal-configuration"
        >
          <Icon name="settings" size={16} />
          <span>Configuration</span>
        </button>

        <button type="button" className="source-chip" id="text-text-global-data-source" onClick={onSource}>
          <span className={`live-dot${feed?.status === "ready" ? " live-dot--ready" : ""}`} />
          <span>{sourceLabel}</span>
          <StatusPill tone={feed?.status === "error" ? "danger" : feed?.mode === "prim-live" ? "ok" : "purple"}>{sourceStatus}</StatusPill>
        </button>

        <div className="speed-control" id="text-text-global-clock-controls" role="group" aria-label={`Operational clock controls; each step advances ${stepSeconds} ${stepSeconds === 1 ? "second" : "seconds"}`}>
          <button type="button" className={speed === 0 ? "active" : ""} aria-label="Pause operational clock" aria-pressed={speed === 0} onClick={() => setSpeed(0)}><Icon name="pause" size={15} /></button>
          {([1, 2, 4] as const).map((value) => <button type="button" className={speed === value ? "active" : ""} aria-label={`Set operational clock rate to ×${value}`} aria-pressed={speed === value} key={value} onClick={() => setSpeed(value)}>×{value}</button>)}
          <button
            type="button"
            className="speed-control__reset"
            onClick={onReset}
            aria-label="Reset operational workspace"
          >
            Reset
          </button>
        </div>

        <div className="operational-clock" id="text-text-global-operational-clock">
          <Icon name="clock" size={17} />
          <div><strong>{formatOperationalTime(snapshot.timestamp)}</strong><small>{formatOperationalDate(snapshot.timestamp)} · Paris</small></div>
        </div>

        {onSignOut && (
          <button
            type="button"
            className="simview-link sign-out-button"
            id="text-text-global-sign-out"
            onClick={() => void onSignOut()}
            aria-label="Sign out"
            title="Sign out"
          >
            <Icon name="logout" size={16} />
            <span>Sign out</span>
          </button>
        )}
      </div>
    </header>
  );
}
