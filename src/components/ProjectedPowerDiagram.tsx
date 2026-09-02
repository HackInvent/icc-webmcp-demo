import type { PowerStatus } from "../rail/domain";
import type { ProjectedTractionPowerLine } from "../rail/tractionPowerView";

interface ProjectedPowerDiagramProps {
  view: ProjectedTractionPowerLine;
}

const STATUS_COLOR: Record<PowerStatus, string> = {
  energized: "#148a68",
  degraded: "#c17b13",
  isolated: "#c93645",
};

function stationLabelLines(label: string): readonly string[] {
  if (label.length <= 20) return [label];
  const words = label.split(" ");
  if (words.length < 2) return [label];
  const target = label.length / 2;
  let splitIndex = 1;
  let length = words[0]?.length ?? 0;
  while (splitIndex < words.length - 1 && length + 1 + (words[splitIndex]?.length ?? 0) < target) {
    length += 1 + (words[splitIndex]?.length ?? 0);
    splitIndex += 1;
  }
  return [words.slice(0, splitIndex).join(" "), words.slice(splitIndex).join(" ")];
}

export function ProjectedPowerDiagram({ view }: ProjectedPowerDiagramProps) {
  const { line, sections } = view;
  const startX = 80;
  const endX = 1100;
  const railY = 292;
  const segmentWidth = (endX - startX) / Math.max(1, sections.length);
  const boundaryLabels = sections.length > 0
    ? [sections[0]?.fromStationName ?? line.name, ...sections.map((section) => section.toStationName)]
    : [line.name];

  return (
    <div className="power-diagram power-diagram--projected" data-line-id={line.code} data-power-projection="topology">
      <svg viewBox="0 0 1180 410" role="group" aria-label={`${line.name} modelled traction-power coverage diagram`}>
        <text x={startX} y="30" className="power-diagram__scope">FULL-LINE TOPOLOGY PROJECTION · ELECTRICAL TELEMETRY NOT CONNECTED</text>

        {sections.map((section, index) => {
          const sectionStart = startX + index * segmentWidth;
          const sectionEnd = sectionStart + segmentWidth;
          const sectionWidth = Math.min(232, Math.max(190, segmentWidth - 18));
          const sectionX = sectionStart + (segmentWidth - sectionWidth) / 2;
          const centerX = (sectionStart + sectionEnd) / 2;
          const statusColor = STATUS_COLOR[section.status];
          return (
            <g
              key={section.id}
              className={`power-node power-node--projected power-node--${section.status}`}
              data-model-power-section-id={section.id}
              role="group"
              aria-label={`${section.name}, ${section.rangeLabel}, ${section.status === "degraded" ? "active linked power constraint" : "no linked power constraint"}`}
            >
              <rect x={sectionX} y="48" width={sectionWidth} height="112" rx="12" className="substation-box" />
              <rect x={sectionX} y="48" width="7" height="112" rx="4" fill={line.color} />
              <text x={sectionX + 20} y="76" className="power-title">{section.name}</text>
              <text x={sectionX + 20} y="99" className="power-subtitle">{section.interstationIds.length} interstations · topology model</text>
              <text x={sectionX + 20} y="125" className="power-reading power-reading--model">MODELLED</text>
              <circle cx={sectionX + 22} cy="145" r="5" fill={statusColor} />
              <text x={sectionX + 34} y="149" className="power-status">{section.status === "degraded" ? "ACTIVE CONSTRAINT" : "NO LINKED CONSTRAINT"}</text>

              <line x1={centerX} y1="160" x2={centerX} y2="190" className="power-bus" />
              <circle cx={centerX} cy="204" r="14" className="power-breaker" stroke={statusColor} />
              <path d={`M${centerX - 7} 204h14M${centerX} 197v14`} stroke={statusColor} strokeWidth="2" />
              <line x1={centerX} y1="218" x2={centerX} y2="244" className="power-bus" stroke={statusColor} />
              <line x1={sectionStart + 5} y1="250" x2={sectionEnd - 5} y2="250" className="power-section-band" stroke={statusColor} />
              <title>{`${section.id} · ${section.rangeLabel} · ${section.linkedIncidentIds.length ? section.linkedIncidentIds.join(", ") : "no linked incident"}`}</title>
            </g>
          );
        })}

        {sections.map((section, index) => {
          const x1 = startX + index * segmentWidth;
          const x2 = x1 + segmentWidth;
          return (
            <g key={`${section.id}-route`} className="power-interstation" data-model-power-route-section={section.id}>
              <line x1={x1} y1={railY} x2={x2} y2={railY} className="power-line-base" />
              <line x1={x1} y1={railY} x2={x2} y2={railY} className="power-line-route" stroke={line.color} />
              {section.status !== "energized" && <line x1={x1 + 10} y1={railY} x2={x2 - 10} y2={railY} className={`power-line-constraint power-line-constraint--${section.status}`} />}
              <text x={(x1 + x2) / 2} y={railY + 23} textAnchor="middle" className="power-circuit-label">{section.interstationIds.length} interstations</text>
            </g>
          );
        })}

        {boundaryLabels.map((station, index) => {
          const x = startX + index * segmentWidth;
          const labels = stationLabelLines(station);
          return (
            <g key={`${station}-${index}`} className="power-station" data-station-name={station}>
              <circle cx={x} cy={railY} r="10" fill="#ffffff" stroke={line.color} strokeWidth="4" />
              <text x={x} y={railY + 58} textAnchor="middle" className="power-station-label">
                {labels.map((label, lineIndex) => <tspan key={`${label}-${lineIndex}`} x={x} dy={lineIndex === 0 ? 0 : 16}>{label}</tspan>)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
