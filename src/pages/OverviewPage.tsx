import { useState } from "react";
import type { RailSnapshot } from "../rail/domain";
import type { NativeSimulationSnapshot } from "../rail/nativeSimulation";
import type { SimulatorIncidentCreationResult, SimulatorIncidentDraft } from "../rail/simulatorIncident";
import {
  RatpNetworkSchematic,
  type NativeIncidentDeclarationTarget,
} from "../components/RatpNetworkSchematic";
import { SimulatorIncidentModal } from "../components/SimulatorIncidentModal";

interface OverviewPageProps {
  snapshot: RailSnapshot;
  nativeSimulation: NativeSimulationSnapshot;
  operationalResponse?: unknown;
  nativeIncidentId?: string;
  onIncidentActivate: (incidentId: string) => void;
  onCreateIncident: (draft: SimulatorIncidentDraft) =>
    SimulatorIncidentCreationResult | Promise<SimulatorIncidentCreationResult>;
}

export function OverviewPage({
  snapshot,
  nativeSimulation,
  operationalResponse,
  nativeIncidentId,
  onIncidentActivate,
  onCreateIncident,
}: OverviewPageProps) {
  const [incidentTarget, setIncidentTarget] = useState<NativeIncidentDeclarationTarget | null>(null);
  const [declaredIncidentId, setDeclaredIncidentId] = useState<string | null>(null);

  const declareIncident = async (
    draft: SimulatorIncidentDraft,
  ): Promise<SimulatorIncidentCreationResult> => {
    const result = await onCreateIncident(draft);
    if (result.ok && result.incidentId) setDeclaredIncidentId(result.incidentId);
    return result;
  };

  return (
    <div className="page page--overview-map" id="text-text-overview-page">
      <RatpNetworkSchematic
        simulation={nativeSimulation}
        operationalResponse={operationalResponse}
        focusIncidentId={nativeIncidentId}
        revealIncidentId={declaredIncidentId ?? undefined}
        onIncidentActivate={onIncidentActivate}
        onDeclareIncident={setIncidentTarget}
      />
      {incidentTarget && (
        <SimulatorIncidentModal
          key={`${incidentTarget.targetType}:${incidentTarget.lineCode}:${incidentTarget.targetId}`}
          snapshot={snapshot}
          nativeSimulation={nativeSimulation}
          initialLine={incidentTarget.lineCode}
          initialTarget={incidentTarget}
          context="operations"
          onClose={() => setIncidentTarget(null)}
          onSubmit={declareIncident}
        />
      )}
    </div>
  );
}
