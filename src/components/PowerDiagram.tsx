import type { KeyboardEvent } from "react";
import type { EntitySelection, LineId, PowerSection, RailSnapshot } from "../rail/domain";
import { lineDefinition } from "../rail/topology";

interface PowerDiagramProps {
  snapshot: RailSnapshot;
  lineId: LineId;
  onSelect: (selection: EntitySelection) => void;
}

const STATUS_COLOR: Record<PowerSection["status"], string> = {
  energized: "#148a68",
  degraded: "#c17b13",
  isolated: "#c93645",
};

function stationLabelLines(label: string): string[] {
  if (label.length <= 18) return [label];
  const separator = label.includes(" – ") ? " – " : " ";
  const words = label.split(separator);
  if (words.length < 2) return [label];

  const target = label.length / 2;
  let splitIndex = 1;
  let length = words[0].length;
  while (splitIndex < words.length - 1 && length + separator.length + words[splitIndex].length < target) {
    length += separator.length + words[splitIndex].length;
    splitIndex += 1;
  }
  return [words.slice(0, splitIndex).join(separator), words.slice(splitIndex).join(separator)];
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

export function PowerDiagram({ snapshot, lineId, onSelect }: PowerDiagramProps) {
  const line = lineDefinition(lineId);
  const sections = snapshot.powerSections.filter((section) => section.lineIds.includes(lineId));
  const circuits = snapshot.circuits
    .filter((circuit) => circuit.lineId === lineId && circuit.direction === 1)
    .sort((left, right) => left.segmentIndex - right.segmentIndex);
  const startX = 90;
  const endX = 1090;
  const segmentWidth = (endX - startX) / Math.max(1, line.stations.length - 1);
  const railY = 292;

  return (
    <div className="power-diagram" data-line-id={lineId}>
      <svg viewBox="0 0 1180 410" role="group" aria-label={`${line.name} single-line electrical diagram`}>
        <text x={startX} y="30" className="power-diagram__scope">OPERATING CORRIDOR · {line.powerSupply.toUpperCase()}</text>

        {sections.map((section) => {
          const sectionCircuits = circuits.filter((circuit) => circuit.electricalSectionId === section.id);
          const firstIndex = sectionCircuits.length ? Math.min(...sectionCircuits.map((circuit) => circuit.segmentIndex)) : 0;
          const lastIndex = sectionCircuits.length ? Math.max(...sectionCircuits.map((circuit) => circuit.segmentIndex)) : firstIndex;
          const sectionStart = startX + firstIndex * segmentWidth;
          const sectionEnd = startX + (lastIndex + 1) * segmentWidth;
          const sectionWidth = Math.max(170, sectionEnd - sectionStart - 12);
          const sectionX = sectionStart + (sectionEnd - sectionStart - sectionWidth) / 2;
          const centerX = (sectionStart + sectionEnd) / 2;
          const statusColor = STATUS_COLOR[section.status];
          return (
            <g
              key={section.id}
              className={`power-node power-node--${section.status}`}
              data-electrical-section-id={section.id}
              role="button"
              tabIndex={0}
              aria-label={`${section.name}, ${section.status}, ${section.voltage} volts, ${section.status === "isolated" ? "load unavailable" : `${section.loadPercent} percent load`}`}
              onClick={() => onSelect({ type: "power", id: section.id })}
              onKeyDown={(event) => activateOnKeyboard(event, () => onSelect({ type: "power", id: section.id }))}
            >
              <rect x={sectionX} y="48" width={sectionWidth} height="112" rx="12" className="substation-box" />
              <rect x={sectionX} y="48" width="7" height="112" rx="4" fill={line.color} />
              <text x={sectionX + 20} y="76" className="power-title">{section.name}</text>
              <text x={sectionX + 20} y="98" className="power-subtitle">{section.substation}</text>
              <text x={sectionX + 20} y="124" className="power-reading">{section.voltage} V</text>
              <text x={sectionX + 102} y="124" className="power-subtitle">{section.currentAmps} A · {section.status === "isolated" ? "load N/A" : `${section.loadPercent}% load`}</text>
              <circle cx={sectionX + 22} cy="145" r="5" fill={statusColor} />
              <text x={sectionX + 34} y="149" className="power-status">{section.status.toUpperCase()}</text>

              <line x1={centerX} y1="160" x2={centerX} y2="190" className="power-bus" />
              <circle cx={centerX} cy="204" r="14" className="power-breaker" stroke={statusColor} />
              <path d={`M${centerX - 7} 204h14M${centerX} 197v14`} stroke={statusColor} strokeWidth="2" />
              <line x1={centerX} y1="218" x2={centerX} y2="244" className="power-bus" stroke={statusColor} />
              <line x1={sectionStart + 4} y1="250" x2={sectionEnd - 4} y2="250" className="power-section-band" stroke={statusColor} />
              <title>{`${section.id} · ${section.voltage} V · ${section.currentAmps} A`}</title>
            </g>
          );
        })}

        {circuits.map((circuit) => {
          const section = sections.find((candidate) => candidate.id === circuit.electricalSectionId);
          const x1 = startX + circuit.segmentIndex * segmentWidth;
          const x2 = x1 + segmentWidth;
          return (
            <g key={circuit.id} className="power-interstation" data-circuit-id={circuit.id}>
              <line x1={x1} y1={railY} x2={x2} y2={railY} className="power-line-base" />
              <line x1={x1} y1={railY} x2={x2} y2={railY} className="power-line-route" stroke={line.color} />
              {section?.status !== "energized" && (
                <line x1={x1 + 10} y1={railY} x2={x2 - 10} y2={railY} className={`power-line-constraint power-line-constraint--${section?.status ?? "energized"}`} />
              )}
              <text x={(x1 + x2) / 2} y={railY + 23} textAnchor="middle" className="power-circuit-label">{circuit.label}</text>
            </g>
          );
        })}

        {line.stations.map((station, index) => {
          const x = startX + index * segmentWidth;
          const lines = stationLabelLines(station);
          return (
            <g key={station} className="power-station" data-station-name={station}>
              <circle cx={x} cy={railY} r="10" fill="#ffffff" stroke={line.color} strokeWidth="4" />
              <text x={x} y={railY + 58} textAnchor="middle" className="power-station-label">
                {lines.map((label, lineIndex) => (
                  <tspan key={label} x={x} dy={lineIndex === 0 ? 0 : 16}>{label}</tspan>
                ))}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
