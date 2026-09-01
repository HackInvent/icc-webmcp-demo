import { type FormEvent, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { useRuntimeConfiguration } from "../runtime/RuntimeGate";
import {
  discoverNativeWebMcpTools,
  executeNativeWebMcpTool,
  NativeWebMcpError,
  type NativeWebMcpCatalog,
} from "./nativeWebMcp";

interface EmbeddedAgentProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  expectedToolNames: readonly string[];
  toolsReady: boolean;
}

interface AgentCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

type AgentTurn =
  | { status: "tool_calls"; runId: string; calls: AgentCall[] }
  | {
      status: "completed";
      runId: string;
      message: string;
      usage?: { inputTokens: number; outputTokens: number };
    };

interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "error";
  text: string;
  toolName?: string;
  toolStatus?: "running" | "completed" | "failed";
  arguments?: Record<string, unknown>;
}

class AgentApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AgentApiError";
    this.status = status;
  }
}

function messageId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function agentRequest(body: Record<string, unknown>, signal: AbortSignal): Promise<AgentTurn> {
  const response = await fetch("/api/agent/turn", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AgentApiError(response.status, "The agent server returned an unreadable response.");
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "message" in payload &&
      typeof payload.message === "string"
      ? payload.message
      : "The embedded agent could not complete this turn.";
    throw new AgentApiError(response.status, message);
  }
  return payload as AgentTurn;
}

function toolOutcome(output: string): string {
  try {
    const value = JSON.parse(output) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const status = typeof record.status === "string" ? record.status.replaceAll("_", " ") : "completed";
      const message = typeof record.message === "string" ? ` · ${record.message}` : "";
      return `${status}${message}`.slice(0, 220);
    }
  } catch {
    // A native client may return a non-JSON text result. It remains valid evidence.
  }
  return output.trim().slice(0, 220) || "completed";
}

function failedToolOutput(error: unknown): string {
  return JSON.stringify({
    status: "tool_execution_failed",
    message: error instanceof Error ? error.message.slice(0, 240) : "Native WebMCP execution failed.",
  });
}

export function EmbeddedAgent({
  open,
  onOpen,
  onClose,
  expectedToolNames,
  toolsReady,
}: EmbeddedAgentProps) {
  const { configuration, signOut } = useRuntimeConfiguration();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 80);
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const updateToolMessage = (
    id: string,
    status: ConversationMessage["toolStatus"],
    text: string,
  ) => {
    setMessages((current) => current.map((message) =>
      message.id === id ? { ...message, toolStatus: status, text } : message
    ));
  };

  const executeCalls = async (
    catalog: NativeWebMcpCatalog,
    calls: AgentCall[],
    signal: AbortSignal,
  ): Promise<Array<{ callId: string; output: string }>> => {
    const outputs = [];
    for (const call of calls) {
      const id = messageId("tool");
      setMessages((current) => [...current, {
        id,
        role: "tool",
        toolName: call.name,
        toolStatus: "running",
        text: "Native WebMCP call in progress…",
        arguments: call.arguments,
      }]);
      try {
        const output = await executeNativeWebMcpTool(
          catalog,
          call.name,
          call.arguments,
          signal,
        );
        outputs.push({ callId: call.callId, output });
        updateToolMessage(id, "completed", toolOutcome(output));
      } catch (error) {
        if (signal.aborted) throw error;
        const output = failedToolOutput(error);
        outputs.push({ callId: call.callId, output });
        updateToolMessage(
          id,
          "failed",
          error instanceof Error ? error.message : "Native WebMCP execution failed.",
        );
      }
    }
    return outputs;
  };

  const send = async (requestedPrompt: string) => {
    const normalizedPrompt = requestedPrompt.trim();
    if (!normalizedPrompt || busy || !configuration.agent.enabled || !toolsReady) return;
    setPrompt("");
    setBusy(true);
    setMessages((current) => [...current, {
      id: messageId("user"),
      role: "user",
      text: normalizedPrompt,
    }]);
    const controller = new AbortController();
    abortRef.current = controller;
    let currentRunId = runId;
    try {
      const catalog = await discoverNativeWebMcpTools(expectedToolNames);
      let turn = await agentRequest(
        currentRunId
          ? { runId: currentRunId, prompt: normalizedPrompt }
          : { prompt: normalizedPrompt, tools: catalog.definitions },
        controller.signal,
      );
      let rounds = 0;
      while (turn.status === "tool_calls") {
        rounds += 1;
        if (rounds > configuration.agent.maxToolRounds) {
          throw new Error("The browser stopped an unexpectedly long WebMCP tool loop.");
        }
        currentRunId = turn.runId;
        setRunId(turn.runId);
        const toolOutputs = await executeCalls(catalog, turn.calls, controller.signal);
        turn = await agentRequest({ runId: turn.runId, toolOutputs }, controller.signal);
      }
      currentRunId = turn.runId;
      setRunId(turn.runId);
      setMessages((current) => [...current, {
        id: messageId("assistant"),
        role: "assistant",
        text: turn.message,
      }]);
    } catch (error) {
      if (controller.signal.aborted) {
        setMessages((current) => [...current, {
          id: messageId("error"),
          role: "error",
          text: "Agent turn cancelled. No pending tool call will continue.",
        }]);
      } else {
        if (error instanceof AgentApiError && error.status === 401) {
          window.location.reload();
          return;
        }
        if (error instanceof AgentApiError && error.status === 404) setRunId(null);
        setMessages((current) => [...current, {
          id: messageId("error"),
          role: "error",
          text: error instanceof NativeWebMcpError || error instanceof Error
            ? error.message
            : "The embedded agent could not complete this turn.",
        }]);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const reset = () => {
    abortRef.current?.abort();
    if (runId) {
      void fetch("/api/agent/reset", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
    }
    setRunId(null);
    setMessages([]);
    setPrompt("");
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send(prompt);
  };

  return (
    <>
      <button
        type="button"
        className={`agent-launcher${open ? " agent-launcher--open" : ""}`}
        onClick={open ? onClose : onOpen}
        aria-label={open ? "Close Paris ICC agent" : "Open Paris ICC agent"}
        aria-hidden={open}
        tabIndex={open ? -1 : 0}
      >
        <span><Icon name="radio" size={18} /></span>
        <b>Ask Paris ICC</b>
        <i>{!configuration.agent.enabled ? "Agent offline" : toolsReady ? "WebMCP agent" : "Publishing tools"}</i>
      </button>
      {open && <>
        <div className="embedded-agent__scrim" onClick={onClose} aria-hidden="true" />
        <aside
          className="embedded-agent embedded-agent--open"
          aria-label="Paris ICC embedded decision-support agent"
        >
        <header className="embedded-agent__header">
          <div className="embedded-agent__identity">
            <span><Icon name="radio" size={19} /></span>
            <div><small>SERVER-HOSTED · NATIVE WEBMCP</small><strong>Ask Paris ICC</strong></div>
          </div>
          <div className="embedded-agent__header-actions">
            <button type="button" onClick={reset} title="New conversation"><Icon name="reset" size={16} /></button>
            <button type="button" onClick={onClose} title="Close agent"><Icon name="close" size={17} /></button>
          </div>
        </header>

        <div className="embedded-agent__trust">
          <span><i className={configuration.agent.enabled ? "is-live" : ""} />{configuration.agent.model ?? "Agent disabled"}</span>
          <span>{expectedToolNames.length || 18} page tools</span>
          <span>Writes need approval</span>
        </div>

        <div className="embedded-agent__conversation" ref={scrollRef} aria-live="polite">
          {messages.length === 0 && (
            <div className="embedded-agent__welcome">
              <span><Icon name="network" size={25} /></span>
              <h2>Decision support on the live page</h2>
              <p>
                The model runs on the server, but every operational fact comes back
                through this page’s native WebMCP tools. Choose a guided mission:
              </p>
              <div className="embedded-agent__presets">
                {configuration.agent.presets.map((preset) => (
                  <button
                    type="button"
                    key={preset.id}
                    onClick={() => void send(preset.prompt)}
                    disabled={busy || !configuration.agent.enabled || !toolsReady}
                  >
                    <Icon name="arrow" size={14} />
                    <span><strong>{preset.label}</strong><small>Inspect current page evidence</small></span>
                  </button>
                ))}
              </div>
              {!configuration.agent.enabled && (
                <p className="embedded-agent__disabled">
                  The embedded model is disabled in this runtime. Configure the production server JSON to enable it.
                </p>
              )}
              {configuration.agent.enabled && !toolsReady && (
                <p className="embedded-agent__disabled">
                  Paris ICC is publishing its 18 native WebMCP tools. Missions unlock automatically when the page is ready.
                </p>
              )}
            </div>
          )}
          {messages.map((message) => (
            <article
              className={`embedded-agent__message embedded-agent__message--${message.role}`}
              key={message.id}
            >
              {message.role === "tool" ? (
                <>
                  <div className="embedded-agent__tool-title">
                    <span><Icon name={message.toolStatus === "failed" ? "alert" : "activity"} size={14} /></span>
                    <strong>{message.toolName}</strong>
                    <i className={`tool-status tool-status--${message.toolStatus}`}>{message.toolStatus}</i>
                  </div>
                  <p>{message.text}</p>
                  {message.arguments && Object.keys(message.arguments).length > 0 && (
                    <details><summary>Typed arguments</summary><pre>{JSON.stringify(message.arguments, null, 2)}</pre></details>
                  )}
                </>
              ) : (
                <>
                  <small>{message.role === "user" ? "YOU" : message.role === "assistant" ? "PARIS ICC" : "TURN STOPPED"}</small>
                  <p>{message.text}</p>
                </>
              )}
            </article>
          ))}
          {busy && (
            <div className="embedded-agent__working" role="status"><i /><i /><i /><span>Inspecting page evidence…</span></div>
          )}
        </div>

        <form className="embedded-agent__composer" onSubmit={submit}>
          <textarea
            ref={inputRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (prompt.trim()) void send(prompt);
              }
            }}
            placeholder="Ask about an incident, train, line, schedule or response option…"
            rows={2}
            disabled={busy || !configuration.agent.enabled || !toolsReady}
          />
          <button
            type={busy ? "button" : "submit"}
            onClick={busy ? () => abortRef.current?.abort() : undefined}
            disabled={!busy && (!prompt.trim() || !configuration.agent.enabled || !toolsReady)}
            aria-label={busy ? "Cancel agent turn" : "Send to Paris ICC agent"}
          >
            <Icon name={busy ? "close" : "arrow"} size={17} />
          </button>
        </form>
        <footer className="embedded-agent__footer">
          <span><Icon name="shield" size={13} /> API key remains server-side</span>
          {!configuration.developmentBypass && <button type="button" onClick={() => void signOut()}>Sign out</button>}
        </footer>
        </aside>
      </>}
    </>
  );
}
