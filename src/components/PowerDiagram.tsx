import type { KeyboardEvent } from "react";
import type { EntitySelection, RailSnapshot } from "../rail/domain";
import { lineDefinition } from "../rail/topology";

interface PowerDiagramProps {
  snapshot: RailSnapshot;
  onSelect: (selection: EntitySelection) => void;
}

function activateOnKeyboard(
  event: KeyboardEvent<SVGGElement>,
  action: () => void,
): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}

export function PowerDiagram({ snapshot, onSelect }: PowerDiagramProps) {
  return (
    <div className="power-diagram">
      <svg viewBox="0 0 980 420" role="group" aria-label="Single-line diagram of electrical sections">
        {snapshot.powerSections.map((section, index) => {
          const column = index % 4;
          const row = Math.floor(index / 4);
          const x = 90 + column * 235;
          const y = 76 + row * 190;
          const line = lineDefinition(section.lineIds[0]);
          const statusColor = section.status === "energized" ? "#5de2b1" : section.status === "degraded" ? "#ffbd67" : "#ff6472";
          return (
            <g
              key={section.id}
              className="power-node"
              role="button"
              tabIndex={0}
              aria-label={`${section.name}, ${section.status}, ${section.voltage} volts, ${section.status === "isolated" ? "load unavailable" : `${section.loadPercent} percent load`}`}
              onClick={() => onSelect({ type: "power", id: section.id })}
              onKeyDown={(event) => activateOnKeyboard(event, () => onSelect({ type: "power", id: section.id }))}
            >
              <line x1={x} y1={y + 18} x2={x} y2={y + 55} className="power-bus" />
              <circle cx={x} cy={y + 70} r="14" fill="#0b1816" stroke={statusColor} strokeWidth="3" />
              <path d={`M${x - 7} ${y + 70}h14M${x} ${y + 63}v14`} stroke={statusColor} strokeWidth="2" />
              <line x1={x} y1={y + 84} x2={x} y2={y + 117} className="power-bus" stroke={statusColor} />
              <rect x={x - 76} y={y - 34} width="152" height="52" rx="10" className="substation-box" />
              <rect x={x - 76} y={y - 34} width="5" height="52" rx="2" fill={line.color} />
              <text x={x - 60} y={y - 13} className="power-title">{section.name}</text>
              <text x={x - 60} y={y + 5} className="power-subtitle">{section.voltage} V · {section.status === "isolated" ? "load N/A" : `${section.loadPercent} %`}</text>
              <rect x={x - 82} y={y + 117} width="164" height="30" rx="8" fill="#10201d" stroke="#29433e" />
              <circle cx={x - 65} cy={y + 132} r="4" fill={statusColor} />
              <text x={x - 53} y={y + 136} className="power-status">{section.status.toUpperCase()}</text>
              <title>{section.id} · {section.voltage} V · {section.currentAmps} A</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
