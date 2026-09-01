import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import {
  ProcedureEditorModal,
  type PublishProcedureStepHandler,
} from "../components/ProcedureEditorModal";
import { StatusPill } from "../components/StatusPill";
import {
  OPERATIONAL_PROCEDURE_CATALOGUE,
  OPERATIONAL_PROCEDURE_CATALOGUE_METADATA,
  type OperationalProcedure,
} from "../procedures";

function dateLabel(timestamp: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(timestamp);
}

function phaseTone(phase: string): "danger" | "warning" | "purple" | "ok" | "info" {
  if (phase === "protect") return "danger";
  if (phase === "diagnose" || phase === "coordinate") return "warning";
  if (phase === "recover") return "purple";
  if (phase === "verify" || phase === "close") return "ok";
  return "info";
}

export interface ProceduresPageProps {
  initialProcedureId?: string;
  procedures?: readonly OperationalProcedure[];
  metadata?: {
    readonly procedureCount?: number;
    readonly revision: string;
    readonly contentHash: string;
  };
  onPublishStep?: PublishProcedureStepHandler;
}

interface OpenEditor {
  procedureId: string;
  stepId?: string;
}

export function ProceduresPage({
  initialProcedureId,
  procedures = OPERATIONAL_PROCEDURE_CATALOGUE,
  metadata = OPERATIONAL_PROCEDURE_CATALOGUE_METADATA,
  onPublishStep,
}: ProceduresPageProps) {
  const [query, setQuery] = useState("");
  const [openEditor, setOpenEditor] = useState<OpenEditor | null>(null);
  const [selectedId, setSelectedId] = useState(
    initialProcedureId && procedures.some((procedure) => procedure.procedureId === initialProcedureId)
      ? initialProcedureId
      : procedures[0]?.procedureId ?? "",
  );
  useEffect(() => {
    if (initialProcedureId && procedures.some((procedure) => procedure.procedureId === initialProcedureId)) {
      setSelectedId(initialProcedureId);
      setQuery("");
    }
  }, [initialProcedureId, procedures]);
  useEffect(() => {
    if (!procedures.some((procedure) => procedure.procedureId === selectedId)) {
      setSelectedId(procedures[0]?.procedureId ?? "");
    }
  }, [procedures, selectedId]);
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return procedures;
    return procedures.filter((procedure) =>
      [
        procedure.procedureId,
        procedure.title,
        procedure.summary,
        ...procedure.applicability.incidentCodes,
      ].join(" ").toLowerCase().includes(normalized)
    );
  }, [procedures, query]);
  const selected: OperationalProcedure | undefined =
    procedures.find((procedure) => procedure.procedureId === selectedId) ??
    visible[0];
  const editorProcedure = openEditor
    ? procedures.find((procedure) => procedure.procedureId === openEditor.procedureId)
    : undefined;

  return (
    <div className="page procedures-page" id="text-text-procedures-page">
      <PageHeader
        contentId="text-text-procedures-header"
        eyebrow="CONTROLLED OPERATIONAL KNOWLEDGE"
        title="Failure-management procedures"
        description="The agent searches this versioned corpus after an incident has been coded. It may explain and prioritise, but every proposed action must cite one of these document steps."
        actions={(
          <>
            <StatusPill tone="purple">
              {metadata.procedureCount ?? procedures.length} procedures · {metadata.revision}
            </StatusPill>
            {selected && (
              <button
                type="button"
                className="button button--primary procedures-page__edit-button"
                data-testid="procedure-editor-open"
                onClick={() => setOpenEditor({ procedureId: selected.procedureId })}
              >
                <Icon name="wrench" size={16}/>
                Edit procedure
              </button>
            )}
          </>
        )}
      />

      <section className="procedures-layout" id="text-text-procedures-workspace">
        <aside className="panel procedure-library" id="text-text-procedures-library">
          <header className="procedure-library__header" id="text-text-procedures-library-header">
            <div>
              <small>DOCUMENT REGISTER</small>
              <h2>Applicable procedures</h2>
            </div>
            <label className="procedure-library__search">
              <Icon name="search" size={16}/>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search code or procedure"
                aria-label="Search procedure library"
              />
            </label>
          </header>
          <div className="procedure-library__list" id="text-text-procedures-library-list">
            {visible.map((procedure) => (
              <button
                type="button"
                key={procedure.procedureId}
                className={procedure.procedureId === selected?.procedureId ? "active" : ""}
                onClick={() => setSelectedId(procedure.procedureId)}
              >
                <span>
                  <strong>{procedure.title}</strong>
                  <small>{procedure.procedureId} · rev. {procedure.revision}</small>
                </span>
                <div>
                  {procedure.applicability.incidentCodes.map((code) => (
                    <code key={code}>{code}</code>
                  ))}
                </div>
                <Icon name="chevron" size={16}/>
              </button>
            ))}
            {visible.length === 0 && (
              <div className="simulator-empty">
                <Icon name="search" size={24}/>
                <strong>No matching procedure</strong>
                <span>Try an incident code, document ID, or keyword.</span>
              </div>
            )}
          </div>
        </aside>

        {selected && (
          <article className="panel procedure-document" id="text-text-procedures-document">
            <header className="procedure-document__header" id="text-text-procedures-document-header">
              <div>
                <small>RETRIEVED DOCUMENT PREVIEW</small>
                <h2>{selected.title}</h2>
                <p>{selected.summary}</p>
              </div>
              <StatusPill tone="purple">versioned catalogue</StatusPill>
            </header>

            <dl className="procedure-document__metadata" id="text-text-procedures-metadata">
              <div><dt>Procedure ID</dt><dd>{selected.procedureId}</dd></div>
              <div><dt>Revision</dt><dd>{selected.revision}</dd></div>
              <div><dt>Effective from</dt><dd>{dateLabel(selected.effectiveFrom)}</dd></div>
              <div><dt>Document reference</dt><dd>{selected.procedureId}/{selected.revision}</dd></div>
              <div><dt>Integrity</dt><dd><code>{selected.contentHash}</code></dd></div>
            </dl>

            <section className="procedure-document__applicability" id="text-text-procedures-applicability">
              <div>
                <small>INCIDENT CODES</small>
                <p>{selected.applicability.incidentCodes.map((code) => <code key={code}>{code}</code>)}</p>
              </div>
              <div>
                <small>APPLIES TO</small>
                <p>{selected.applicability.targetTypes.join(", ")} · {selected.applicability.effects.join(", ")}</p>
              </div>
            </section>

            <section className="procedure-document__steps" id="text-text-procedures-steps">
              <header>
                <small>CONTROLLED WORKFLOW</small>
                <h3>Mandatory procedure steps</h3>
              </header>
              <ol>
                {selected.steps.map((step) => (
                  <li key={step.stepId}>
                    <span>{step.order / 10}</span>
                    <div>
                      <header>
                        <div>
                          <StatusPill tone={phaseTone(step.phase)}>{step.phase}</StatusPill>
                          <strong>{step.title}</strong>
                        </div>
                        <div className="procedure-document__step-actions">
                          <code>{step.stepId}</code>
                          <button
                            type="button"
                            className="button button--secondary"
                            data-testid={`procedure-editor-open-${step.stepId}`}
                            onClick={() => setOpenEditor({ procedureId: selected.procedureId, stepId: step.stepId })}
                          >
                            <Icon name="wrench" size={13}/>
                            Edit step
                          </button>
                        </div>
                      </header>
                      <p>{step.instruction}</p>
                      <aside>
                        <span><b>Responsible:</b> {step.responsibleRole}</span>
                        <span><b>Capability:</b> {step.capability ?? "documented operator check"}</span>
                      </aside>
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <section className="procedure-document__normal" id="text-text-procedures-return-to-normal">
              <header>
                <div>
                  <small>RETURN TO NORMAL</small>
                  <h3>{selected.returnToNormal.objective}</h3>
                </div>
                <StatusPill tone="warning">
                  {selected.returnToNormal.observationWindowSeconds}s observation
                </StatusPill>
              </header>
              <ul>
                {selected.returnToNormal.criteria.map((criterion) => (
                  <li key={criterion.criterionId}>
                    <Icon name="shield" size={15}/>
                    <span><strong>{criterion.label}</strong><small>{criterion.evidence}</small></span>
                  </li>
                ))}
              </ul>
            </section>
          </article>
        )}
      </section>
      {editorProcedure && (
        <ProcedureEditorModal
          key={`${editorProcedure.procedureId}:${editorProcedure.revision}:${openEditor?.stepId ?? "first"}`}
          procedure={editorProcedure}
          initialStepId={openEditor?.stepId}
          onClose={() => setOpenEditor(null)}
          onPublishStep={onPublishStep}
        />
      )}
    </div>
  );
}
