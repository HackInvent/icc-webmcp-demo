import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { LineId } from "../rail/domain";
import { LINES } from "../rail/topology";
import { Icon } from "./Icon";
import { StatusPill } from "./StatusPill";

interface LineReferenceCardsProps {
  selectedLine: LineId | "ALL";
  onSelectLine: (lineId: LineId) => void;
}

export function LineReferenceCards({ selectedLine, onSelectLine }: LineReferenceCardsProps) {
  const [referenceLine, setReferenceLine] = useState<LineId>(() =>
    selectedLine === "ALL" ? LINES[0]!.id : selectedLine,
  );

  useEffect(() => {
    if (selectedLine !== "ALL") setReferenceLine(selectedLine);
  }, [selectedLine]);

  return (
    <section className="line-reference" aria-labelledby="line-reference-heading">
      <header className="line-reference__header">
        <div>
          <span className="panel__eyebrow">PROVENANCE & REALISM</span>
          <h2 id="line-reference-heading">Line reference baseline</h2>
          <p>Full-line facts; the operational schematic uses a condensed control corridor.</p>
          <small className="line-reference__snapshot">Wikipedia reference snapshot · consulted 26 Aug 2026</small>
        </div>
        <StatusPill tone="info">4 public references</StatusPill>
      </header>

      <div className="line-reference__grid">
        {LINES.map((line) => {
          const selected = referenceLine === line.id;
          return (
            <article
              key={line.id}
              className={`line-reference-card${selected ? " line-reference-card--selected" : ""}`}
              style={{ "--reference-line-color": line.color } as CSSProperties}
            >
              <button
                type="button"
                className="line-reference-card__select"
                aria-pressed={selected}
                aria-label={`Select ${line.name}`}
                onClick={() => {
                  setReferenceLine(line.id);
                  onSelectLine(line.id);
                }}
              >
                <span className="line-reference-card__identity">
                  <i style={{ background: line.color, color: line.textColor }}>{line.shortName}</i>
                  <span><strong>{line.name}</strong><small>{line.operator}</small></span>
                  {selected && <em>Selected</em>}
                </span>
              </button>
              <p className="line-reference-card__axis">{line.axis}</p>
              <div className="line-reference-card__metrics">
                <span><strong>{line.lineLengthKm}</strong><small>km full line</small></span>
                <span><strong>{line.stationCount}</strong><small>stations</small></span>
              </div>
              <dl>
                <div><dt>Rolling stock</dt><dd>{line.rollingStock}</dd></div>
                <div><dt>Train control</dt><dd>{line.controlSystem}</dd></div>
                <div><dt>Power</dt><dd>{line.powerSupply}</dd></div>
                <div><dt>Real termini</dt><dd>{line.termini.join(" ↔ ")}</dd></div>
              </dl>
              <div className="line-reference-card__corridor">
                <Icon name="panel" size={14} />
                <span><small>CONDENSED CONTROL CORRIDOR</small><strong>{line.simulatedCorridor}</strong></span>
              </div>
              <a href={line.wikipediaUrl} target="_blank" rel="noopener noreferrer">
                Wikipedia reference <Icon name="external" size={13} />
              </a>
            </article>
          );
        })}
      </div>

      <footer>
        <Icon name="shield" size={15} />
        <p>
          Reference metadata describes the full real line. The schematic is deliberately condensed for operational decision support and is not a geographic, signalling, or infrastructure-exact representation.
        </p>
      </footer>
    </section>
  );
}
