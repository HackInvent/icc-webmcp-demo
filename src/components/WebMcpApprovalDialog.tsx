import { Icon } from "./Icon";
import { Modal } from "./Modal";

export interface WebMcpApprovalView {
  id: string;
  toolName: string;
  label: string;
  kind: "read" | "analysis" | "write";
  input: Readonly<Record<string, unknown>>;
  requestedAt: string;
}

interface WebMcpApprovalDialogProps {
  request: WebMcpApprovalView;
  onDecision: (approved: boolean) => void;
}

export function WebMcpApprovalDialog({
  request,
  onDecision,
}: WebMcpApprovalDialogProps) {
  const isWrite = request.kind === "write";
  const visibleInput = Object.fromEntries(
    Object.entries(request.input).filter(([key]) => key !== "confirmSimulation"),
  );
  return (
    <Modal
      contentId="text-text-modal-webmcp-approval"
      title={isWrite ? "Approve operational action?" : "Approve page inspection?"}
      eyebrow="ONE-SHOT WEBMCP PERMISSION"
      onClose={() => onDecision(false)}
      footer={(
        <>
          <button
            type="button"
            className="button button--secondary"
            data-testid="agent-tool-reject"
            onClick={() => onDecision(false)}
          >
            Reject tool call
          </button>
          <button
            type="button"
            className="button button--primary"
            data-testid="agent-tool-approve"
            onClick={() => onDecision(true)}
          >
            <Icon name="shield" size={15}/>
            {isWrite ? "Approve this action" : "Allow this inspection"}
          </button>
        </>
      )}
    >
      <div
        className={`webmcp-approval webmcp-approval--${request.kind}`}
        data-testid="agent-tool-approval"
      >
        <div className="webmcp-approval__summary">
          <span><Icon name={isWrite ? "alert" : "search"} size={21}/></span>
          <div>
            <small>{request.kind.toUpperCase()} TOOL · EXACT INPUT</small>
            <strong>{request.label}</strong>
            <code>{request.toolName}</code>
          </div>
        </div>
        <p>
          {isWrite
            ? "This call is bound to the displayed decision revision and requires this one-use operator approval."
            : "Permission applies only to this exact WebMCP call and its arguments."}
        </p>
        <div className="webmcp-approval__arguments">
          <span>Arguments requested by the WebMCP client</span>
          <pre>{JSON.stringify(visibleInput, null, 2)}</pre>
        </div>
        <div className="webmcp-approval__guard">
          <Icon name="shield" size={17}/>
          <span>
            <strong>Approval requires this visible operator click.</strong>
            <small>Changing any argument requires a new permission.</small>
          </span>
        </div>
      </div>
    </Modal>
  );
}
