import { useMemo, type KeyboardEvent } from "react";
import type { CircuitView, EntitySelection, LineId, RailSnapshot, TrainView } from "../rail/domain";
import { LINES, lineDefinition } from "../rail/topology";

interface NetworkSchematicProps {
  snapshot: RailSnapshot;
  selectedLine: LineId | "ALL";
  onSelect: (selection: EntitySelection) => void;
  compact?: boolean;
}

function trainPoint(_train: TrainView, circuit: CircuitView) {
  return {
    x: (circuit.x1 + circuit.x2) / 2,
    y: circuit.y,
  };
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

export function NetworkSchematic({ snapshot, selectedLine, onSelect, compact = false }: NetworkSchematicProps) {
  const circuitsById = useMemo(() => new Map(snapshot.circuits.map((circuit) => [circuit.id, circuit])), [snapshot.circuits]);
  const activeLines = selectedLine === "ALL" ? LINES : LINES.filter((line) => line.id === selectedLine);

  return (
    <div className={`network-schematic${compact ? " network-schematic--compact" : ""}`}>
      <svg viewBox="0 0 1100 565" role="group" aria-label="Discrete occupation overview of train services and track circuits">
        <defs>
          <pattern id="blockedPattern" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="7" stroke="#ff5e6c" strokeWidth="3" />
          </pattern>
          <filter id="trainGlow" x="-40%" y="-70%" width="180%" height="240%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>

        {activeLines.map((line) => {
          const lineCircuits = snapshot.circuits.filter((circuit) => circuit.lineId === line.id);
          return (
            <g key={line.id} className="schematic-line">
              <g className="line-label" transform={`translate(17 ${line.y - 18})`}>
                <rect width="48" height="36" rx="12" fill={line.color} />
                <text x="24" y="23" textAnchor="middle" fill={line.textColor}>{line.shortName}</text>
              </g>
              <text x="18" y={line.y + 37} className="line-caption">{line.name}</text>

              {lineCircuits.map((circuit) => {
                const occupied = circuit.state === "occupied";
                const blocked = circuit.state === "blocked" || Boolean(circuit.closure);
                const closure = circuit.closure;
                return (
                  <g
                    key={circuit.id}
                    className={`circuit circuit--${circuit.state}${closure ? " circuit--closed" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Track circuit ${circuit.id}, ${closure ? `closed for ${closure.reason}` : circuit.state}`}
                    onClick={() => onSelect({ type: "circuit", id: circuit.id })}
                    onKeyDown={(event) => activateOnKeyboard(event, () => onSelect({ type: "circuit", id: circuit.id }))}
                  >
                    <line x1={circuit.x1 + 5} x2={circuit.x2 - 5} y1={circuit.y} y2={circuit.y} className="circuit__base" />
                    <line
                      x1={circuit.x1 + 7}
                      x2={circuit.x2 - 7}
                      y1={circuit.y}
                      y2={circuit.y}
                      className="circuit__state"
                      stroke={blocked ? "url(#blockedPattern)" : occupied ? line.color : "#2d4541"}
                    />
                    <line x1={circuit.x1 + 2} x2={circuit.x2 - 2} y1={circuit.y} y2={circuit.y} className="circuit__hit" />
                    {(occupied || blocked) && (
                      <text x={(circuit.x1 + circuit.x2) / 2} y={circuit.y + (circuit.direction === 1 ? -15 : 21)} textAnchor="middle" className={`circuit__label${blocked ? " circuit__label--blocked" : ""}`}>
                        {closure ? `${circuit.id} · CLOSED (${closure.reason.toUpperCase()})` : blocked ? `${circuit.id} · BLOCKED` : `${circuit.id} · ${circuit.circulationId}`}
                      </text>
                    )}
                    <title>{circuit.id} · {closure ? `closed for ${closure.reason}${closure.note ? ` · ${closure.note}` : ""}` : circuit.state}{circuit.circulationId ? ` · ${circuit.circulationId}` : ""}</title>
                  </g>
                );
              })}

              {line.stations.map((station, index) => {
                const x = 88 + index * 184;
                return (
                  <g key={station} className="station">
                    <line x1={x} x2={x} y1={line.y - 16} y2={line.y + 16} />
                    <circle cx={x} cy={line.y - 9} r="3.5" />
                    <circle cx={x} cy={line.y + 9} r="3.5" />
                    <text x={x} y={line.y + 48} textAnchor="middle">{station}</text>
                  </g>
                );
              })}
            </g>
          );
        })}

        {snapshot.trains
          .filter((train) => selectedLine === "ALL" || train.lineId === selectedLine)
          .map((train) => {
            const circuit = circuitsById.get(train.circuitId);
            if (!circuit) return null;
            const point = trainPoint(train, circuit);
            const line = lineDefinition(train.lineId);
            const delayed = train.delaySeconds >= 300;
            return (
              <g
                key={train.id}
                className={`train-marker${train.status === "held" || train.status === "stopped" ? " train-marker--stopped" : ""}`}
                style={{ transform: `translate(${point.x}px, ${point.y}px)` }}
                onClick={() => onSelect({ type: "train", id: train.id })}
                onKeyDown={(event) => activateOnKeyboard(event, () => onSelect({ type: "train", id: train.id }))}
                role="button"
                tabIndex={0}
                aria-label={`Train ${train.id}, service ${train.circulationId}, ${Math.round(train.delaySeconds / 60)} minute delay`}
                data-occupation-model="discrete-track-circuit"
              >
                <rect x="-39" y="-12" width="78" height="24" rx="8" fill="#091614" stroke={delayed ? "#ffba61" : line.color} filter="url(#trainGlow)" />
                <circle cx="-28" cy="0" r="4" fill={train.status === "running" ? line.color : "#ffba61"} />
                <text x="-19" y="3.5">{train.id}</text>
                <title>{train.id} · {train.circulationId} · {Math.round(train.delaySeconds / 60)} min</title>
              </g>
            );
          })}
      </svg>
    </div>
  );
}
