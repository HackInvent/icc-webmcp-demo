import { useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { NATIVE_LINE_BY_CODE, type NativeLineCode } from "../rail/nativeNetwork";
import {
  DEMO_TRACTION_METHODOLOGY,
  ROLLING_STOCK_LINES,
  estimateTractionByLoad,
  getReferenceAssignment,
  getRollingStockFamily,
  getRollingStockProfile,
} from "../rail/rollingStock";

interface RollingStockPageProps {
  initialLineCode?: NativeLineCode;
}

function confidenceLabel(confidence: "high" | "medium" | "low"): string {
  return confidence === "high" ? "Strong public reference" : confidence === "medium" ? "Qualified public reference" : "Exploratory reference";
}

export function RollingStockPage({ initialLineCode = "RER_A" }: RollingStockPageProps) {
  const [lineCode, setLineCode] = useState<NativeLineCode>(initialLineCode);
  const [loadPercent, setLoadPercent] = useState(65);
  const profile = getRollingStockProfile(lineCode);
  const line = NATIVE_LINE_BY_CODE.get(lineCode);
  const referenceAssignment = getReferenceAssignment(lineCode);
  const referenceFamily = getRollingStockFamily(referenceAssignment.familyId);
  const referenceCapacity = referenceFamily.referenceCapacity * referenceAssignment.referenceUnits;
  const estimate = useMemo(() => estimateTractionByLoad({
    familyId: referenceAssignment.familyId,
    formationUnits: referenceAssignment.referenceUnits,
    passengers: Math.round(referenceCapacity * loadPercent / 100),
  }), [loadPercent, referenceAssignment.familyId, referenceAssignment.referenceUnits, referenceCapacity]);

  return (
    <div className="page rolling-stock-page" id="text-text-rolling-stock-page">
      <PageHeader
        contentId="text-text-rolling-stock-header"
        eyebrow="PUBLIC FLEET REFERENCE · DECISION SUPPORT"
        title="Rolling stock & load model"
        description="Traceable fleet, composition and capacity references for all 16 Metro and 5 RER lines. Public facts stay separate from the uncalibrated traction comparison."
        actions={<span className="rs-classification"><Icon name="shield" size={16} /> 21 lines · sourced</span>}
      />

      <div className="rs-line-tabs" role="tablist" aria-label="Rolling-stock line">
        {ROLLING_STOCK_LINES.map((candidate) => {
          const definition = NATIVE_LINE_BY_CODE.get(candidate.lineCode);
          return (
            <button type="button" role="tab" aria-selected={candidate.lineCode === lineCode} aria-controls="rolling-stock-line-panel" key={candidate.lineCode} onClick={() => setLineCode(candidate.lineCode)}>
              <i style={{ backgroundColor: definition?.color ?? "#64748b" }} />{definition?.label ?? candidate.lineCode}
            </button>
          );
        })}
      </div>

      <section className="rs-hero panel" id="rolling-stock-line-panel" role="tabpanel">
        <div className="rs-hero__identity">
          <span className="rs-line-mark" style={{ backgroundColor: line?.color ?? "#147d62" }}>{line?.label}</span>
          <div><span className="panel__eyebrow">SELECTED OPERATIONAL REFERENCE</span><h2>{profile.displayName}</h2><p>{referenceFamily.name} · {referenceFamily.composition}</p></div>
        </div>
        <dl className="rs-hero__facts">
          <div><dt>Reference formation</dt><dd>{referenceAssignment.referenceUnits} × {referenceFamily.cars} cars</dd></div>
          <div><dt>Reference capacity</dt><dd>{referenceCapacity.toLocaleString("en-GB")}</dd></div>
          <div><dt>Standing density</dt><dd>{referenceFamily.standingDensity === null ? "Not stated" : `${referenceFamily.standingDensity} pax/m²`}</dd></div>
          <div><dt>Source confidence</dt><dd>{referenceFamily.confidence}</dd></div>
        </dl>
      </section>

      <div className="rs-workspace">
        <section className="panel rs-fleet-panel">
          <header className="rs-section-header"><div><span className="panel__eyebrow">PUBLISHED FACTS</span><h2>Fleet references on {profile.displayName}</h2></div><a href={profile.sourceUrl} target="_blank" rel="noreferrer"><Icon name="external" size={15} /> Allocation source</a></header>
          <div className="rs-family-grid">
            {profile.assignments.map((candidate) => {
              const family = getRollingStockFamily(candidate.familyId);
              return (
                <article className={`rs-family-card rs-family-card--${candidate.role}`} key={candidate.familyId}>
                  <div className="rs-family-card__top"><span>{candidate.role.replace("-", " ")}</span><small className={`rs-confidence rs-confidence--${family.confidence}`}>{family.confidence}</small></div>
                  <h3>{family.name}</h3><p>{family.composition}</p>
                  <dl><div><dt>Cars</dt><dd>{family.cars}</dd></div><div><dt>Capacity</dt><dd>{family.referenceCapacity.toLocaleString("en-GB")}</dd></div><div><dt>Traction</dt><dd>{family.tractionClass.replaceAll("-", " ")}</dd></div><div><dt>Density</dt><dd>{family.standingDensity === null ? "not stated" : `${family.standingDensity}/m²`}</dd></div></dl>
                  <p className="rs-family-card__basis">{family.capacityBasis}</p>
                  <a href={family.sourceUrl} target="_blank" rel="noreferrer">{family.sourceLabel}<Icon name="external" size={13} /></a>
                  <small>{confidenceLabel(family.confidence)}. {candidate.note}</small>
                </article>
              );
            })}
          </div>
        </section>

        <aside className="panel rs-estimate-panel">
          <header className="rs-section-header"><div><span className="panel__eyebrow">DEMO ESTIMATE · UNCALIBRATED</span><h2>Load sensitivity</h2></div><span className="rs-estimate-badge">not kWh</span></header>
          <p className="rs-estimate-panel__intro">A transparent relative traction index for comparing load scenarios. It is not measured energy and is never presented as billing or engineering telemetry.</p>
          <label className="rs-load-control"><span><b>Modelled load</b><strong>{loadPercent}%</strong></span><input type="range" min="0" max="120" step="5" value={loadPercent} onChange={(event) => setLoadPercent(Number(event.target.value))} /></label>
          <div className="rs-estimate-output"><div><span>Passengers</span><strong>{estimate.passengerCount.toLocaleString("en-GB")}</strong></div><div><span>Payload mass</span><strong>{estimate.payloadMassTonnes.toLocaleString("en-GB")} t</strong></div><div><span>Relative index</span><strong>{estimate.relativeTractionIndexPerTrainKm}</strong></div><div><span>Load delta</span><strong>+{estimate.loadDeltaPercent}%</strong></div></div>
          <div className="rs-method"><h3>Visible assumptions</h3><ul><li>{DEMO_TRACTION_METHODOLOGY.passengerMassKg} kg per passenger, with the EN 15663 reference linked below.</li><li>Distinct demo coefficients for steel wheel, rubber tyre and RER heavy rail.</li><li>No gradients, driving style, auxiliaries, regenerative receptivity or actual consist mass.</li></ul><a href={DEMO_TRACTION_METHODOLOGY.passengerMassSourceUrl} target="_blank" rel="noreferrer"><Icon name="external" size={14} /> Passenger-load standard reference</a></div>
        </aside>
      </div>
    </div>
  );
}
