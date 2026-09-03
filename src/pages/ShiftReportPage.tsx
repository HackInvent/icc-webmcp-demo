import { useEffect, useRef, useState } from "react";
import {
  generateShiftReportDraft,
  type ShiftReportAgentProgress,
} from "../agent/shiftReportAgent";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { StatusPill } from "../components/StatusPill";
import { operationsClient } from "../runtime/operationsClient";
import type { ShiftWorkspaceSnapshot } from "../runtime/types";

type SaveState = "saved" | "saving" | "error";

interface ShiftReportPageProps {
  shift: ShiftWorkspaceSnapshot;
  expectedToolNames?: readonly string[];
  inPageTools?: readonly WebMcpToolDefinition[];
  toolsChecked?: boolean;
  toolsPublished?: boolean;
  agentEnabled?: boolean;
  agentModel?: string | null;
}

const EMPTY_TOOL_NAMES: readonly string[] = Object.freeze([]);
const EMPTY_IN_PAGE_TOOLS: readonly WebMcpToolDefinition[] = Object.freeze([]);

const AGENT_PROGRESS_LABELS: Readonly<Record<ShiftReportAgentProgress, string>> = {
  discovering: "Discovering the Shift Report WebMCP tool",
  inspecting: "Reading persisted shift-log evidence through WebMCP",
  reasoning: "Agent is drafting from verified evidence",
  finalizing: "Validating the draft against the current log revision",
};

function timestamp(value: number | null): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

export function ShiftReportPage({
  shift,
  expectedToolNames = EMPTY_TOOL_NAMES,
  inPageTools = EMPTY_IN_PAGE_TOOLS,
  toolsChecked = false,
  toolsPublished = false,
  agentEnabled = false,
  agentModel = null,
}: ShiftReportPageProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const reportRef = useRef(shift.report);
  const latestHtmlRef = useRef(shift.report.contentHtml);
  const savedHtmlRef = useRef(shift.report.contentHtml);
  const saveTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveMessage, setSaveMessage] = useState(`Saved ${timestamp(shift.report.updatedAt)}`);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentProgress, setAgentProgress] =
    useState<ShiftReportAgentProgress>("discovering");
  const [agentMessage, setAgentMessage] = useState<string | null>(null);
  const [freezeBusy, setFreezeBusy] = useState(false);
  const report = shift.report;
  const frozen = report.status === "frozen";
  const editingLocked = frozen || agentBusy || freezeBusy;
  reportRef.current = report;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    latestHtmlRef.current = report.contentHtml;
    savedHtmlRef.current = report.contentHtml;
    if (editorRef.current) editorRef.current.innerHTML = report.contentHtml;
    setSaveState("saved");
    setSaveMessage(`Saved ${timestamp(report.updatedAt)}`);
    setAgentMessage(null);
  }, [report.reportId]);

  useEffect(() => {
    if (
      report.contentHtml !== savedHtmlRef.current &&
      document.activeElement !== editorRef.current
    ) {
      latestHtmlRef.current = report.contentHtml;
      savedHtmlRef.current = report.contentHtml;
      if (editorRef.current) editorRef.current.innerHTML = report.contentHtml;
    }
    if (saveState !== "saving") {
      setSaveMessage(
        frozen
          ? `Frozen ${timestamp(report.frozenAt)}`
          : `Saved ${timestamp(report.updatedAt)}`,
      );
    }
  }, [frozen, report.contentHtml, report.frozenAt, report.updatedAt, saveState]);

  const persistHtml = async (
    html: string,
    source: "operator" | "agent",
  ): Promise<void> => {
    const currentReport = reportRef.current;
    if (currentReport.status === "frozen") return;
    if (source === "operator" && html === savedHtmlRef.current) return;
    if (mountedRef.current) {
      setSaveState("saving");
      setSaveMessage(source === "agent" ? "Applying agent draft…" : "Autosaving…");
    }
    try {
      const result = await operationsClient.command("update_shift_report", {
        reportId: currentReport.reportId,
        contentHtml: html,
        source,
      });
      const persisted = result.snapshot?.shift.report;
      savedHtmlRef.current = persisted?.contentHtml ?? html;
      const hasNewerOperatorInput = latestHtmlRef.current !== html;
      if (!hasNewerOperatorInput) latestHtmlRef.current = savedHtmlRef.current;
      if (mountedRef.current) {
        setSaveState(hasNewerOperatorInput ? "saving" : "saved");
        setSaveMessage(
          hasNewerOperatorInput
            ? "Newer edits waiting to autosave…"
            : `Saved ${timestamp(persisted?.updatedAt ?? Date.now())}`,
        );
      }
    } catch (error) {
      if (mountedRef.current) {
        setSaveState("error");
        setSaveMessage(error instanceof Error ? error.message : "Autosave failed");
      }
      throw error;
    }
  };

  const scheduleAutosave = (html: string) => {
    latestHtmlRef.current = html;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    setSaveState("saving");
    setSaveMessage("Waiting to autosave…");
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void persistHtml(latestHtmlRef.current, "operator").catch(() => undefined);
    }, 700);
  };

  const format = (command: string, value?: string) => {
    if (editingLocked) return;
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    if (editorRef.current) scheduleAutosave(editorRef.current.innerHTML);
  };

  const requestAgentDraft = async () => {
    if (frozen || agentBusy || !toolsPublished) return;
    setAgentBusy(true);
    setAgentMessage(null);
    setAgentProgress("discovering");
    const controller = new AbortController();
    try {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      await persistHtml(latestHtmlRef.current, "operator");
      const draft = await generateShiftReportDraft({
        reportId: reportRef.current.reportId,
        expectedToolNames,
        inPageTools,
        modelEnabled: agentEnabled,
        signal: controller.signal,
        onProgress: setAgentProgress,
      });
      if (draft.reportId !== reportRef.current.reportId) {
        throw new Error("The report changed during agent drafting. Request a new draft.");
      }
      latestHtmlRef.current = draft.html;
      if (editorRef.current) editorRef.current.innerHTML = draft.html;
      await persistHtml(draft.html, "agent");
      setAgentMessage(
        draft.modelAssisted
          ? `${agentModel ?? "OpenAI"} prepared an editable draft from ${draft.sourceLogCount} persisted log entries through ${draft.transport === "native" ? "Native WebMCP" : "the in-page WebMCP bridge"}.`
          : `A verified chronology was prepared from ${draft.sourceLogCount} entries through ${draft.transport === "native" ? "Native WebMCP" : "the in-page WebMCP bridge"}.${draft.warning ? ` ${draft.warning}` : ""}`,
      );
    } catch (error) {
      setAgentMessage(error instanceof Error ? error.message : "Report assistance failed.");
    } finally {
      setAgentBusy(false);
    }
  };

  const printReport = () => {
    const previousTitle = document.title;
    document.title = report.title;
    window.print();
    document.title = previousTitle;
  };

  const freezeAndPrint = async () => {
    if (freezeBusy) return;
    if (frozen) {
      printReport();
      return;
    }
    if (!window.confirm(
      "Freeze this report? Editing will remain locked until the operational workspace is reset.",
    )) return;
    setFreezeBusy(true);
    try {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      await persistHtml(latestHtmlRef.current, "operator");
      await operationsClient.command("freeze_shift_report", {
        reportId: reportRef.current.reportId,
      });
      window.requestAnimationFrame(printReport);
    } catch (error) {
      setSaveState("error");
      setSaveMessage(error instanceof Error ? error.message : "The report could not be frozen.");
    } finally {
      setFreezeBusy(false);
    }
  };

  return (
    <div className="page shift-report-page" id="text-text-shift-report-page">
      <PageHeader
        contentId="text-text-shift-report-header"
        eyebrow="END-OF-SHIFT RECORD"
        title="Shift report"
        description="Editable operational report backed by the current shift log. Changes autosave to SQLite; freezing locks the document before printing or saving as PDF."
        actions={(
          <div className="shift-report__header-actions">
            <StatusPill tone={frozen ? "ok" : saveState === "error" ? "danger" : "info"}>
              {frozen ? "frozen" : saveState}
            </StatusPill>
            <button
              type="button"
              className="button button--secondary shift-report__agent-button"
              disabled={frozen || agentBusy || !toolsPublished}
              onClick={() => void requestAgentDraft()}
              data-webmcp-tool="inspect_shift_log"
              title={
                toolsChecked && !toolsPublished
                  ? "The Shift Report WebMCP tool is unavailable."
                  : "Read the persisted shift log through WebMCP and prepare an editable draft."
              }
            >
              <Icon name="radio" size={15}/>
              {agentBusy ? "Agent working…" : "Agent draft from shift logs"}
            </button>
            <button
              type="button"
              className="button shift-report__freeze-button"
              disabled={freezeBusy}
              onClick={() => void freezeAndPrint()}
            >
              <Icon name={frozen ? "external" : "shield"} size={15}/>
              {freezeBusy ? "Freezing…" : frozen ? "Print / save PDF" : "Freeze & print PDF"}
            </button>
          </div>
        )}
      />

      <section className="shift-report__meta" id="text-text-shift-report-metadata">
        <div><small>REPORT ID</small><strong>{report.reportId}</strong></div>
        <div><small>SHIFT OPENED</small><strong>{timestamp(shift.startedOperationalTime)}</strong></div>
        <div><small>LOG EVIDENCE</small><strong>{shift.logs.length} entries · seq. {report.sourceLogSequence}</strong></div>
        <div><small>PERSISTENCE</small><strong>{saveMessage}</strong></div>
      </section>

      {(agentBusy || agentMessage) && (
        <div className="shift-report__agent-status" id="text-text-shift-report-agent-status" role="status">
          <Icon name="radio" size={17}/>
          <span>{agentBusy ? AGENT_PROGRESS_LABELS[agentProgress] : agentMessage}</span>
        </div>
      )}

      <section className={`panel shift-report-editor${frozen ? " shift-report-editor--frozen" : ""}`} id="text-text-shift-report-editor">
        <div className="shift-report-toolbar" id="text-text-shift-report-formatting" role="toolbar" aria-label="Report text formatting">
          <button type="button" disabled={editingLocked} onClick={() => format("bold")} aria-label="Bold"><b>B</b></button>
          <button type="button" disabled={editingLocked} onClick={() => format("italic")} aria-label="Italic"><i>I</i></button>
          <button type="button" disabled={editingLocked} onClick={() => format("underline")} aria-label="Underline"><u>U</u></button>
          <button type="button" disabled={editingLocked} onClick={() => format("strikeThrough")} aria-label="Strikethrough"><s>S</s></button>
          <span/>
          <button type="button" disabled={editingLocked} onClick={() => format("formatBlock", "h2")} aria-label="Heading">H2</button>
          <button type="button" disabled={editingLocked} onClick={() => format("formatBlock", "p")} aria-label="Paragraph">¶</button>
          <button type="button" disabled={editingLocked} onClick={() => format("formatBlock", "blockquote")} aria-label="Block quote">“ ”</button>
          <span/>
          <button type="button" disabled={editingLocked} onClick={() => format("insertUnorderedList")} aria-label="Bulleted list">• List</button>
          <button type="button" disabled={editingLocked} onClick={() => format("insertOrderedList")} aria-label="Numbered list">1. List</button>
          <span/>
          <button type="button" disabled={editingLocked} onClick={() => format("undo")} aria-label="Undo">↶</button>
          <button type="button" disabled={editingLocked} onClick={() => format("redo")} aria-label="Redo">↷</button>
          <small>{frozen ? "Editing locked" : "Autosave enabled · no Save button"}</small>
        </div>
        <article
          ref={editorRef}
          className="shift-report-document"
          id="text-text-shift-report-document"
          contentEditable={!editingLocked}
          suppressContentEditableWarning
          spellCheck
          aria-label="Editable end-of-shift report"
          data-report-status={report.status}
          onInput={(event) => scheduleAutosave(event.currentTarget.innerHTML)}
          onBlur={() => {
            if (editingLocked) return;
            if (saveTimerRef.current !== null) {
              window.clearTimeout(saveTimerRef.current);
              saveTimerRef.current = null;
            }
            void persistHtml(latestHtmlRef.current, "operator").catch(() => undefined);
          }}
          onPaste={(event) => {
            event.preventDefault();
            document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
          }}
          dangerouslySetInnerHTML={{ __html: report.contentHtml }}
        />
      </section>
    </div>
  );
}
