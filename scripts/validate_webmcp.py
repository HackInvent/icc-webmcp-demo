#!/usr/bin/env python3
"""Validate Paris ICC through Chromium's native experimental WebMCP CDP domain."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit, urlunsplit

try:
    from playwright.sync_api import CDPSession, Page, sync_playwright
except ImportError:
    print(
        "Playwright Python is required. Run: "
        "python3 -m pip install -r requirements-webmcp.txt",
        file=sys.stderr,
    )
    raise SystemExit(2)


PROJECT_ROOT = Path(__file__).resolve().parents[1]
LEGACY_TOOLS = {
    "apply_reviewed_schedule_change",
    "evaluate_schedule_impact",
    "prepare_shift_brief",
    "get_circulation",
    "inspect_j1_capacity",
    "inspect_network_state",
    "inspect_prim_feed",
    "inspect_schedule_plan",
    "list_operational_incidents",
    "preview_schedule_change",
    "simulate_regulation_action",
    "simulate_track_circuit_closure",
}
NATIVE_NETWORK_TOOLS = {
    "inspect_network_digital_twin",
    "inspect_incident_decision_context",
    "search_operational_procedures",
    "get_operational_procedure",
    "apply_reviewed_procedure_step",
    "create_simulated_network_incident",
    "control_network_simulation",
}
EXPECTED_TOOLS = LEGACY_TOOLS | NATIVE_NETWORK_TOOLS
READ_ONLY_TOOLS = {
    "get_circulation",
    "inspect_j1_capacity",
    "inspect_network_state",
    "inspect_prim_feed",
    "inspect_schedule_plan",
    "list_operational_incidents",
    "prepare_shift_brief",
    "inspect_network_digital_twin",
    "inspect_incident_decision_context",
    "search_operational_procedures",
    "get_operational_procedure",
}
DEFAULT_URL = "http://127.0.0.1:5173/#/overview"


class ValidationError(RuntimeError):
    """Raised when the native WebMCP contract does not match expectations."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def wait_until(
    page: Page,
    predicate: Callable[[], bool],
    timeout_seconds: float,
    description: str,
) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        page.wait_for_timeout(50)
    raise ValidationError(f"Timed out waiting for {description}.")


def url_without_fragment(url: str) -> str:
    parsed = urlsplit(url)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", parsed.query, ""))


def server_is_ready(url: str) -> bool:
    try:
        with urllib.request.urlopen(url_without_fragment(url), timeout=1) as response:
            return 200 <= response.status < 500
    except (OSError, urllib.error.URLError):
        return False


def start_vite_if_needed(
    url: str,
    timeout_seconds: float,
) -> subprocess.Popen[bytes] | None:
    if server_is_ready(url):
        return None

    parsed = urlsplit(url)
    require(
        parsed.hostname in {"127.0.0.1", "localhost"},
        f"Target is unavailable: {url}",
    )
    port = parsed.port or 5173
    process = subprocess.Popen(
        [
            "npm",
            "run",
            "dev",
            "--",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--strictPort",
        ],
        cwd=PROJECT_ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise ValidationError(
                "Vite exited before the validation page became available."
            )
        if server_is_ready(url):
            return process
        time.sleep(0.1)
    process.terminate()
    raise ValidationError(f"Vite did not become ready at {url}.")


def find_chromium(explicit_path: str | None) -> str:
    candidates = [
        explicit_path,
        os.environ.get("WEBMCP_CHROMIUM"),
        shutil.which("chromium"),
        shutil.which("chromium-browser"),
        shutil.which("google-chrome-canary"),
        shutil.which("google-chrome"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    raise ValidationError(
        "Chromium 151+ was not found. Pass --browser or set WEBMCP_CHROMIUM."
    )


class WebMcpClient:
    def __init__(self, page: Page, timeout_seconds: float) -> None:
        self.page = page
        self.timeout_seconds = timeout_seconds
        self.session: CDPSession = page.context.new_cdp_session(page)
        self.tools: dict[str, dict[str, Any]] = {}
        self.responses: dict[str, dict[str, Any]] = {}
        self.removed: list[dict[str, Any]] = []
        self.session.on("WebMCP.toolsAdded", self._tools_added)
        self.session.on("WebMCP.toolsRemoved", self._tools_removed)
        self.session.on("WebMCP.toolResponded", self._tool_responded)
        self.session.send("WebMCP.enable")

    def _tools_added(self, event: dict[str, Any]) -> None:
        for tool in event.get("tools", []):
            self.tools[tool["name"]] = tool

    def _tools_removed(self, event: dict[str, Any]) -> None:
        for tool in event.get("tools", []):
            current = self.tools.get(tool["name"])
            if current is None or current.get("frameId") == tool.get("frameId"):
                self.tools.pop(tool["name"], None)
            self.removed.append(tool)

    def _tool_responded(self, event: dict[str, Any]) -> None:
        self.responses[event["invocationId"]] = event

    def wait_for_tools(self, expected: set[str]) -> None:
        wait_until(
            self.page,
            lambda: set(self.tools) == expected,
            self.timeout_seconds,
            f"tools {sorted(expected)} (observed {sorted(self.tools)})",
        )

    def invoke(self, name: str, input_data: dict[str, Any]) -> dict[str, Any]:
        tool = self.tools.get(name)
        if tool is None:
            raise ValidationError(f"Tool is not registered: {name}")
        response = self.session.send(
            "WebMCP.invokeTool",
            {
                "frameId": tool["frameId"],
                "toolName": name,
                "input": input_data,
            },
        )
        invocation_id = response["invocationId"]
        approval_clicked = False

        def response_ready() -> bool:
            nonlocal approval_clicked
            if invocation_id in self.responses:
                return True
            if not approval_clicked:
                approve = self.page.get_by_test_id(
                    "agent-tool-approve"
                )
                try:
                    if approve.is_visible(timeout=50):
                        approve.click()
                        approval_clicked = True
                except Exception:
                    # The approval is rendered asynchronously. Keep polling
                    # until the tool responds or the shared timeout expires.
                    pass
            return invocation_id in self.responses

        wait_until(
            self.page,
            response_ready,
            self.timeout_seconds,
            f"response from {name}",
        )
        return self.responses.pop(invocation_id)

    def invoke_completed(self, name: str, input_data: dict[str, Any]) -> Any:
        response = self.invoke(name, input_data)
        require(
            response.get("status") == "Completed",
            f"{name} failed through CDP: {response}",
        )
        output = response.get("output")
        if isinstance(output, str):
            try:
                return json.loads(output)
            except json.JSONDecodeError:
                return output
        return output


def validate_catalog(client: WebMcpClient) -> dict[str, Any]:
    client.wait_for_tools(EXPECTED_TOOLS)
    for name, tool in client.tools.items():
        require(
            bool(tool.get("description", "").strip()),
            f"{name} has no description.",
        )
        schema = tool.get("inputSchema")
        require(
            isinstance(schema, dict) and schema.get("type") == "object",
            f"{name} has an invalid schema.",
        )
        require(
            schema.get("additionalProperties") is False,
            f"{name} must reject unknown properties.",
        )
        read_only = bool(tool.get("annotations", {}).get("readOnly"))
        require(
            read_only == (name in READ_ONLY_TOOLS),
            f"{name} has an incorrect read-only annotation.",
        )
    network_line_enum = (
        client.tools["inspect_network_state"]
        .get("inputSchema", {})
        .get("properties", {})
        .get("line", {})
        .get("enum", [])
    )
    require(
        network_line_enum == ["RER_A", "RER_B", "M13", "M14"],
        f"Network line catalogue is not canonical: {network_line_enum}",
    )
    require(
        "RER_D" not in network_line_enum,
        "Retired RER D leaked into the WebMCP line catalogue.",
    )
    return {
        "count": len(client.tools),
        "names": sorted(client.tools),
        "originFrames": len({tool["frameId"] for tool in client.tools.values()}),
    }


def validate_invocations(client: WebMcpClient) -> dict[str, Any]:
    prim = client.invoke_completed("inspect_prim_feed", {})
    require(
        prim.get("mode") == "prim-replay"
        and prim.get("contract") == "SIRI Lite Estimated Timetable"
        and len(prim.get("coverage", [])) == 4
        and prim.get("provenance") == "synthetic_values_in_authentic_siri_lite_contract",
        f"PRIM contract-replay evidence is inconsistent: {prim}",
    )
    brief = client.invoke_completed("prepare_shift_brief", {})
    require(
        brief.get("status") == "brief_ready",
        "Cross-domain shift brief did not complete.",
    )
    picture = brief.get("operationalPicture", {})
    require(
        picture.get("trainsInScope") == 12
        and picture.get("operationalIncidents") == 2
        and picture.get("plannedWorksOrEvents") == 1
        and picture.get("passengersOnAffectedTrains") == 1665
        and picture.get("degradedOrIsolatedPowerSections") == 1
        and picture.get("driverReliefRisks") == 2,
        f"Cross-domain shift brief is inconsistent: {picture}",
    )
    priorities = brief.get("priorities", [])
    require(
        bool(priorities)
        and priorities[0].get("reference") == "INC-2407"
        and priorities[0].get("rank") == 1,
        f"Cross-domain priorities are not deterministic: {priorities}",
    )
    schedule_context = brief.get("schedule", {})
    require(
        schedule_context.get("status") == "loaded"
        and str(schedule_context.get("planHash", "")).startswith("schedule-")
        and schedule_context.get("humanAuthorizationActive") is False,
        "Cross-domain brief did not expose the versioned review state.",
    )
    require(
        brief.get("guardrails", {}).get("humanApprovalRequiredForWrites") is True
        and brief.get("guardrails", {}).get("liveSignallingAvailable") is False,
        "Cross-domain brief guardrails are missing.",
    )
    network = client.invoke_completed(
        "inspect_network_state",
        {"line": "RER_B"},
    )
    require(
        network.get("status") == "ok",
        "Network inspection did not return ok.",
    )
    require(
        network.get("source") == "simulation",
        "Network source is not the safe simulation.",
    )
    require(
        network.get("line") == "RER_B" and network.get("trains") == 3,
        "RER B summary is inconsistent.",
    )
    require(
        network.get("powerSections") == 2
        and network.get("degradedPowerSections") == 1
        and network.get("isolatedPowerSections") == 0,
        "RER B power summary is inconsistent.",
    )
    network_a = client.invoke_completed(
        "inspect_network_state",
        {"line": "RER_A"},
    )
    require(
        network_a.get("status") == "ok"
        and network_a.get("line") == "RER_A"
        and network_a.get("trains") == 3,
        "RER A summary is inconsistent.",
    )
    retired_line = client.invoke(
        "inspect_network_state",
        {"line": "RER_D"},
    )
    require(
        retired_line.get("status") == "Error",
        "Retired RER D was not rejected by the native tool schema.",
    )

    circulation = client.invoke_completed(
        "get_circulation",
        {"trainId": "ILOT44"},
    )
    require(
        circulation.get("train", {}).get("id") == "MI79-205",
        "Circulation lookup returned the wrong train.",
    )

    capacity = client.invoke_completed(
        "inspect_j1_capacity",
        {"line": "RER_B"},
    )
    capacity_summary = {
        "totalCapacityTokens": capacity.get("totalCapacityTokens"),
        "assigned": capacity.get("assigned"),
        "reserve": capacity.get("reserve"),
        "reliefRisk": capacity.get("reliefRisk"),
    }
    return validate_invocations_tail(
        client,
        prim=prim,
        brief=brief,
        network=network,
        network_a=network_a,
        retired_line=retired_line,
        circulation=circulation,
        capacity=capacity,
        capacity_summary=capacity_summary,
    )


def validate_native_network_decision(client: WebMcpClient) -> dict[str, Any]:
    """Exercise the coded-incident procedure workflow through native WebMCP."""
    twin = client.invoke_completed(
        "inspect_network_digital_twin",
        {"limit": 12},
    )
    topology = twin.get("topology", {})
    indicators = twin.get("indicators", {})
    require(
        twin.get("status") == "ok"
        and topology.get("lineCount") == 21
        and topology.get("stationCount") == 390
        and topology.get("interstationCount") == 467,
        f"Native topology contract is inconsistent: {topology}",
    )
    require(
        twin.get("simulationOnly") is True
        and len(twin.get("limitations", [])) >= 3
        and "RATP" in twin.get("provenance", {}).get("topology", ""),
        "Native twin provenance and simulation boundary are missing.",
    )
    require(
        indicators.get("trainsInScope") == 42
        and indicators.get("incidentsInScope") == 3,
        f"Native operating picture is inconsistent: {indicators}",
    )
    incidents = twin.get("incidents", [])
    require(bool(incidents), "Native twin exposed no coded decision incident.")
    incident = incidents[0]
    incident_id = incident["id"]
    incident_code = incident.get("incidentCode")
    line_code = incident["lineCodes"][0]
    require(
        isinstance(incident_code, str) and incident_code.startswith("ICC-INC-"),
        f"Native incident codification is missing: {incident}",
    )

    decision = client.invoke_completed(
        "inspect_incident_decision_context",
        {"incidentId": incident_id},
    )
    inspected_incident = decision.get("incident", {})
    require(
        decision.get("status") == "context_ready"
        and inspected_incident.get("id") == incident_id
        and inspected_incident.get("incidentCode") == incident_code
        and len(decision.get("recommendedWorkflow", [])) == 4,
        f"Native coded incident context is incomplete: {decision}",
    )
    decision_revision = decision["evidence"]["decisionRevision"]

    procedure_search = client.invoke_completed(
        "search_operational_procedures",
        {"incidentCode": incident_code},
    )
    matches = procedure_search.get("matches", [])
    require(
        procedure_search.get("status") == "procedures_found"
        and procedure_search.get("incidentCode") == incident_code
        and isinstance(procedure_search.get("catalogRevision"), str)
        and bool(procedure_search.get("catalogRevision"))
        and isinstance(matches, list)
        and len(matches) >= 1,
        f"No exact procedure was found for {incident_code}: {procedure_search}",
    )
    procedure_match = matches[0]
    procedure_id = procedure_match.get("procedureId")
    procedure_revision = procedure_match.get("revision")
    procedure_hash = procedure_match.get("contentHash")
    require(
        isinstance(procedure_id, str)
        and isinstance(procedure_revision, str)
        and isinstance(procedure_hash, str)
        and procedure_hash.startswith("sha256:")
        and "sourceKind" not in procedure_match
        and "official" not in procedure_match,
        f"Procedure search identity is incomplete: {procedure_match}",
    )

    retrieved = client.invoke_completed(
        "get_operational_procedure",
        {
            "procedureId": procedure_id,
            "procedureRevision": procedure_revision,
            "procedureContentHash": procedure_hash,
        },
    )
    procedure = retrieved.get("procedure", {})
    steps = procedure.get("steps", [])
    require(
        retrieved.get("status") == "procedure_ready"
        and procedure.get("procedureId") == procedure_id
        and procedure.get("revision") == procedure_revision
        and procedure.get("contentHash") == procedure_hash
        and "sourceKind" not in procedure
        and "official" not in procedure
        and "safetyNotice" not in procedure
        and bool(procedure.get("documentRef"))
        and isinstance(steps, list)
        and len(steps) >= 1
        and bool(procedure.get("normalStateCriteria")),
        f"Retrieved procedure evidence is incomplete: {retrieved}",
    )
    executable_steps = [
        step for step in steps
        if isinstance(step, dict)
        and isinstance(step.get("capability"), dict)
        and step["capability"].get("requiresOperatorConfirmation") is True
    ]
    acknowledgement_step = next(
        (
            step for step in executable_steps
            if step["capability"].get("command") == "acknowledge"
        ),
        None,
    )
    procedure_step = next(
        (
            step for step in executable_steps
            if step["capability"].get("command") == "protect-and-hold"
        ),
        None,
    )
    require(
        acknowledgement_step is not None
        and isinstance(acknowledgement_step.get("stepId"), str)
        and procedure_step is not None
        and isinstance(procedure_step.get("stepId"), str)
        and bool(procedure_step.get("rationale")),
        f"The procedure exposes no cited acknowledge/protection sequence: {steps}",
    )
    acknowledgement_step_id = acknowledgement_step["stepId"]
    step_id = procedure_step["stepId"]
    acknowledgement_input = {
        "incidentId": incident_id,
        "procedureId": procedure_id,
        "procedureRevision": procedure_revision,
        "procedureContentHash": procedure_hash,
        "stepId": acknowledgement_step_id,
        "expectedDecisionRevision": decision_revision,
        "confirmSimulation": True,
    }

    stale_step = client.invoke_completed(
        "apply_reviewed_procedure_step",
        {
            **acknowledgement_input,
            "expectedDecisionRevision": decision_revision + 1,
        },
    )
    require(
        stale_step.get("status") == "blocked"
        and stale_step.get("reason") == "stale_decision_context",
        f"A stale procedure step was not blocked: {stale_step}",
    )

    stale_procedure = client.invoke_completed(
        "apply_reviewed_procedure_step",
        {
            **acknowledgement_input,
            "procedureContentHash": "sha256:" + "0" * 64,
        },
    )
    require(
        stale_procedure.get("status") == "blocked"
        and stale_procedure.get("reason") == "stale_procedure",
        f"A mismatched procedure hash was not blocked: {stale_procedure}",
    )

    acknowledged = client.invoke_completed(
        "apply_reviewed_procedure_step",
        acknowledgement_input,
    )
    require(
        acknowledged.get("status") == "procedure_step_acknowledged"
        and acknowledged.get("incidentCode") == incident_code
        and acknowledged.get("procedureId") == procedure_id
        and acknowledged.get("procedureRevision") == procedure_revision
        and acknowledged.get("procedureContentHash") == procedure_hash
        and acknowledged.get("stepId") == acknowledgement_step_id
        and acknowledged.get("capability") == "acknowledge"
        and acknowledged.get("decisionRevision") == decision_revision
        and acknowledged.get("mutationApplied") is False
        and acknowledged.get("simulationConfirmationRecorded") is True
        and bool(acknowledged.get("receiptId")),
        f"The first mandatory procedure step was not acknowledged: {acknowledged}",
    )
    duplicate_acknowledgement = client.invoke_completed(
        "apply_reviewed_procedure_step",
        acknowledgement_input,
    )
    require(
        duplicate_acknowledgement.get("status") == "blocked"
        and duplicate_acknowledgement.get("reason") == "no_op",
        f"A duplicate procedure acknowledgement was not blocked: {duplicate_acknowledgement}",
    )

    apply_input = {
        **acknowledgement_input,
        "stepId": step_id,
    }
    applied = client.invoke_completed(
        "apply_reviewed_procedure_step",
        apply_input,
    )
    require(
        applied.get("status") == "applied_to_simulation"
        and applied.get("incidentCode") == incident_code
        and applied.get("procedureId") == procedure_id
        and applied.get("procedureRevision") == procedure_revision
        and applied.get("procedureContentHash") == procedure_hash
        and applied.get("stepId") == step_id
        and applied.get("capability") == "protect-and-hold"
        and applied.get("decisionRevision") == decision_revision + 1
        and applied.get("mutationApplied") is True
        and applied.get("simulationConfirmationRecorded") is True
        and bool(applied.get("receiptId")),
        f"Reviewed procedure step was not applied safely: {applied}",
    )
    current_revision = applied["decisionRevision"]

    replay = client.invoke_completed(
        "apply_reviewed_procedure_step",
        {
            **apply_input,
            "expectedDecisionRevision": current_revision,
        },
    )
    require(
        replay.get("status") == "blocked"
        and replay.get("reason") == "no_op",
        f"An already active procedure capability was replayed: {replay}",
    )

    paused = client.invoke_completed(
        "control_network_simulation",
        {
            "action": "pause",
            "expectedDecisionRevision": current_revision,
            "confirmSimulation": True,
        },
    )
    require(
        paused.get("status") == "simulation_control_applied"
        and paused.get("speed") == 0,
        f"WebMCP could not pause the native simulation: {paused}",
    )
    current_revision = paused["decisionRevision"]
    duplicate_pause = client.invoke_completed(
        "control_network_simulation",
        {
            "action": "pause",
            "expectedDecisionRevision": current_revision,
            "confirmSimulation": True,
        },
    )
    require(
        duplicate_pause.get("status") == "blocked"
        and duplicate_pause.get("reason") == "no_op",
        "A redundant native simulation control was not blocked.",
    )

    target = incident["target"]
    if target["type"] == "station":
        alternate_effect = (
            "dwell_extension"
            if incident.get("effect") != "dwell_extension"
            else "closure"
        )
    elif target["type"] == "train":
        alternate_effect = "dwell_extension"
    else:
        alternate_effect = (
            "speed_restriction"
            if incident.get("effect") != "speed_restriction"
            else "closure"
        )
    created = client.invoke_completed(
        "create_simulated_network_incident",
        {
            "targetType": target["type"],
            "targetId": target["id"],
            "lineCode": line_code,
            "type": "infrastructure",
            "effect": alternate_effect,
            "severity": "medium",
            "title": "WebMCP validation exercise",
            "expectedDecisionRevision": current_revision,
            "confirmSimulation": True,
        },
    )
    require(
        created.get("status") == "created_in_simulation"
        and created.get("decisionRevision") == current_revision + 1
        and str(created.get("incident", {}).get("incidentCode", "")).startswith("ICC-INC-"),
        f"WebMCP did not create a coded map-bound incident: {created}",
    )
    current_revision = created["decisionRevision"]

    restored = client.invoke_completed(
        "control_network_simulation",
        {
            "action": "reset",
            "expectedDecisionRevision": current_revision,
            "confirmSimulation": True,
        },
    )
    require(
        restored.get("status") == "simulation_control_applied"
        and restored.get("speed") == 1,
        f"Native scenario was not restored after validation: {restored}",
    )
    verified = client.invoke_completed(
        "inspect_network_digital_twin",
        {"limit": 12},
    )
    require(
        verified.get("operational", {}).get("decisionRevision")
        == restored.get("decisionRevision")
        and verified.get("indicators", {}).get("incidentsInScope") == 3,
        "The native post-action revision is not observable through WebMCP.",
    )

    marker = client.page.locator(
        f"[data-presentation-incident-id=\"{incident_id}\"]"
    )
    marker.wait_for(state="visible")
    marker.click(force=True)
    modal = client.page.get_by_test_id(
        "native-incident-decision-modal"
    )
    modal.wait_for(state="visible")
    continue_to_options = modal.get_by_role(
        "button", name="Continue to action options"
    )
    wait_until(
        client.page,
        lambda: continue_to_options.count() == 1
        and continue_to_options.is_visible(),
        client.timeout_seconds,
        "procedure-grounded situation assessment",
    )
    continue_to_options.click()
    action_cards = modal.locator(".incident-option")
    wait_until(
        client.page,
        lambda: action_cards.count() >= 1,
        client.timeout_seconds,
        "cited procedure options",
    )
    modal_text = modal.inner_text()
    action_count = action_cards.count()
    review_buttons = modal.get_by_role("button", name="Review this step")
    require(
        incident_id in modal_text
        and incident_code in modal_text
        and procedure_id in modal_text
        and procedure_revision in modal_text
        and "Agent proposal for the operator" in modal_text
        and "Native WebMCP" in modal_text
        and "NOT AN OFFICIAL RATP/IDFM INSTRUCTION" not in modal_text
        and action_count >= 1
        and review_buttons.count() == action_count,
        "The procedure-grounded incident decision modal is incomplete.",
    )
    chat_surface_absent = client.page.locator(
        ".agent-console,.agent-launcher,.embedded-agent"
    ).count() == 0
    require(
        chat_surface_absent,
        "A deprecated chat surface is still visible.",
    )

    review_buttons.first.click()
    execution_card = modal.locator(
        "[data-testid^=\"incident-procedure-step-\"]"
    )
    execution_card.wait_for(state="visible")
    require(
        execution_card.locator(".procedure-citation").count() == 1
        and execution_card.locator(":scope > footer button").count() == 1,
        "The selected procedure step is not isolated in the execution stage.",
    )
    execution_card.locator(":scope > footer button").click()
    approval = client.page.get_by_test_id(
        "agent-tool-approval"
    )
    approval.wait_for(state="visible")
    approval_text = approval.inner_text()
    require(
        "apply_reviewed_procedure_step" in approval_text
        and incident_id in approval_text
        and procedure_id in approval_text
        and procedure_revision in approval_text
        and procedure_hash in approval_text
        and "stepId" in approval_text
        and "confirmSimulation" not in approval_text,
        "The exact procedure-bound WebMCP approval is not visible.",
    )
    client.page.get_by_test_id("agent-tool-reject").click()
    modal.get_by_text(
        "Procedure step not applied", exact=True
    ).wait_for(state="visible")
    require(
        modal.is_visible(),
        "Rejecting the procedure step unexpectedly closed the decision modal.",
    )
    modal.locator(
        "xpath=ancestor::section[@role=\"dialog\"]"
    ).get_by_role(
        "button", name="Close dialog", exact=True
    ).click()
    modal.wait_for(state="detached")

    return {
        "topology": {
            "lines": topology["lineCount"],
            "stations": topology["stationCount"],
            "interstations": topology["interstationCount"],
        },
        "fleet": indicators["trainsInScope"],
        "incident": incident_id,
        "incidentCode": incident_code,
        "context": decision["status"],
        "procedureSearch": procedure_search["status"],
        "catalogRevision": procedure_search["catalogRevision"],
        "procedureId": procedure_id,
        "procedureRevision": procedure_revision,
        "procedureHash": procedure_hash,
        "acknowledgementStep": acknowledgement_step_id,
        "acknowledgement": acknowledged["status"],
        "duplicateAcknowledgement": duplicate_acknowledgement["reason"],
        "procedureStep": step_id,
        "staleDecisionGuard": stale_step["reason"],
        "staleProcedureGuard": stale_procedure["reason"],
        "apply": applied["status"],
        "receipt": applied["receiptId"],
        "replay": replay["reason"],
        "pause": paused["status"],
        "redundantControl": duplicate_pause["reason"],
        "incidentCreation": created["status"],
        "reset": restored["status"],
        "finalDecisionRevision": restored["decisionRevision"],
        "decisionModal": "procedure_grounded_headless_webmcp",
        "citedActionButtons": action_count,
        "chatSurfaceAbsent": chat_surface_absent,
        "operatorApprovalVisible": True,
        "rejectedWritePreservedSimulation": True,
    }


def validate_invocations_tail(
    client: WebMcpClient,
    *,
    prim: dict[str, Any],
    brief: dict[str, Any],
    network: dict[str, Any],
    network_a: dict[str, Any],
    retired_line: dict[str, Any],
    circulation: dict[str, Any],
    capacity: dict[str, Any],
    capacity_summary: dict[str, Any],
) -> dict[str, Any]:
    require(
        capacity_summary
        == {
            "totalCapacityTokens": 4,
            "assigned": 2,
            "reserve": 1,
            "reliefRisk": 1,
        },
        "D-1 capacity aggregate is inconsistent.",
    )
    require(
        "drivers" not in capacity,
        "D-1 capacity leaked individual driver records.",
    )

    incidents = client.invoke_completed(
        "list_operational_incidents",
        {"status": "active"},
    )
    incident_ids = [
        incident["id"]
        for incident in incidents.get("incidents", [])
    ]
    require(
        incident_ids == ["INC-2407"],
        f"Unexpected active incidents: {incident_ids}",
    )

    invalid = client.invoke(
        "get_circulation",
        {"trainId": "MI79-205", "unexpected": True},
    )
    require(
        invalid.get("status") == "Error",
        "Unknown tool properties were not rejected.",
    )

    before = client.invoke_completed(
        "get_circulation",
        {"trainId": "MI79-205"},
    )
    regulation: dict[str, Any] | None = None
    accepted_revision: int | None = None
    for _ in range(4):
        current = client.invoke_completed("inspect_network_state", {})
        candidate_revision = current["writeGuard"]["expectedRevision"]
        candidate = client.invoke_completed(
            "simulate_regulation_action",
            {
                "trainId": "MI79-205",
                "action": "priority",
                "expectedRevision": candidate_revision,
                "confirmSimulation": True,
            },
        )
        if candidate.get("status") == "applied_to_simulation":
            regulation = candidate
            accepted_revision = candidate_revision
            break
        require(
            candidate.get("reason") == "stale_snapshot",
            f"Regulation was unexpectedly blocked: {candidate}",
        )
    require(
        regulation is not None and accepted_revision is not None,
        "Could not apply the safe simulation action.",
    )

    client.page.wait_for_timeout(50)
    after = client.invoke_completed(
        "get_circulation",
        {"trainId": "MI79-205"},
    )
    require(
        after["decisionRevision"] > accepted_revision,
        "Regulation did not advance the simulation decision revision.",
    )
    require(
        after["train"]["delaySeconds"]
        == max(0, before["train"]["delaySeconds"] - 120),
        "Priority action did not produce the expected simulated delay change.",
    )

    stale = client.invoke_completed(
        "simulate_regulation_action",
        {
            "trainId": "MI79-205",
            "action": "hold",
            "expectedRevision": accepted_revision,
            "confirmSimulation": True,
        },
    )
    require(
        stale.get("status") == "blocked"
        and stale.get("reason") == "stale_snapshot",
        "Stale revision was not blocked.",
    )

    return {
        "primEvidence": {
            "status": prim["status"],
            "mode": prim["mode"],
            "provenance": prim["provenance"],
            "contract": prim["contract"],
            "coveredLines": len(prim["coverage"]),
        },
        "readTools": {
            "inspect_prim_feed": prim["status"],
            "prepare_shift_brief": brief["status"],
            "inspect_network_state": network["status"],
            "inspect_network_state_RER_A": network_a["status"],
            "get_circulation": circulation["status"],
            "inspect_j1_capacity": capacity["status"],
            "list_operational_incidents": incidents["status"],
        },
        "invalidInput": invalid["status"],
        "retiredLineInput": retired_line["status"],
        "regulation": regulation["status"],
        "staleRevision": stale["reason"],
        "decisionRevision": {
            "before": accepted_revision,
            "after": after["decisionRevision"],
        },
        "delaySeconds": {
            "before": before["train"]["delaySeconds"],
            "after": after["train"]["delaySeconds"],
        },
    }


def validate_circuit_closure(
    client: WebMcpClient,
) -> dict[str, Any]:
    page = client.page
    circuit_id = "RB-05-A"
    note = "Points inspection before the engineering possession"

    # Reset and pause make the browser exercise deterministic while retaining
    # the same React and WebMCP paths used by an operator and an agent.
    page.get_by_role("button", name="Reset operational workspace").click()
    pause_button = page.get_by_role("button", name="Pause operational clock")
    pause_button.click()
    wait_until(
        page,
        lambda: "active" in (
            pause_button.get_attribute("class") or ""
        ),
        client.timeout_seconds,
        "paused simulation",
    )

    search = page.get_by_role(
        "combobox",
        name="Global search",
    )
    search.fill(circuit_id)
    page.locator(".search-results button").filter(
        has_text=circuit_id,
    ).click()
    dialog = page.get_by_role("dialog")
    close_button = dialog.get_by_test_id(
        "circuit-close-track-circuit"
    )
    close_button.wait_for(state="visible")
    require(
        close_button.is_enabled(),
        f"{circuit_id} is not available for the UI closure test.",
    )
    dialog.get_by_test_id(
        "circuit-closure-reason-incident"
    ).click()
    dialog.get_by_test_id(
        "circuit-closure-note"
    ).fill("Passenger incident verification")
    close_button.click()
    dialog.get_by_label(
        "Manual track circuit closure"
    ).get_by_text(
        "Closed for incident",
        exact=False,
    ).wait_for()
    reopen_button = dialog.get_by_test_id(
        "circuit-reopen-track-circuit"
    )
    reopen_button.wait_for(state="visible")
    reopen_button.click()
    dialog.get_by_test_id(
        "circuit-close-track-circuit"
    ).wait_for(state="visible")

    baseline = client.invoke_completed(
        "inspect_network_state",
        {},
    )
    baseline_blocked = baseline["blockedTrackCircuits"]
    accepted_revision = baseline["writeGuard"]["expectedRevision"]
    closed = client.invoke_completed(
        "simulate_track_circuit_closure",
        {
            "circuitId": circuit_id,
            "action": "close",
            "reason": "works",
            "note": note,
            "expectedRevision": accepted_revision,
            "confirmSimulation": True,
        },
    )
    require(
        closed.get("status") == "applied_to_simulation"
        and closed.get("outcome") == "closed"
        and closed.get("closureReason") == "works"
        and closed.get("noteAccepted") is True,
        f"WebMCP did not close {circuit_id}: {closed}",
    )
    require(
        note not in json.dumps(closed),
        "The private operator note leaked into the tool result.",
    )
    dialog.get_by_label(
        "Manual track circuit closure"
    ).get_by_text(
        "Closed for works",
        exact=False,
    ).wait_for()

    after_close = client.invoke_completed(
        "inspect_network_state",
        {},
    )
    require(
        after_close["decisionRevision"] > accepted_revision
        and after_close["blockedTrackCircuits"]
        == baseline_blocked + 1,
        "The closed circuit is not reflected in the network snapshot.",
    )
    current_revision = after_close["writeGuard"]["expectedRevision"]

    redundant = client.invoke_completed(
        "simulate_track_circuit_closure",
        {
            "circuitId": circuit_id,
            "action": "close",
            "reason": "works",
            "expectedRevision": current_revision,
            "confirmSimulation": True,
        },
    )
    require(
        redundant.get("status") == "blocked"
        and redundant.get("reason") == "already_closed",
        f"A redundant closure was not blocked: {redundant}",
    )

    circulation = client.invoke_completed(
        "get_circulation",
        {"trainId": "MI79-101"},
    )
    occupied_id = circulation["train"]["circuitId"]
    occupied = client.invoke_completed(
        "simulate_track_circuit_closure",
        {
            "circuitId": occupied_id,
            "action": "close",
            "reason": "incident",
            "expectedRevision": current_revision,
            "confirmSimulation": True,
        },
    )
    require(
        occupied.get("status") == "blocked"
        and occupied.get("reason") == "occupied",
        f"An occupied circuit closure was not blocked: {occupied}",
    )

    stale = client.invoke_completed(
        "simulate_track_circuit_closure",
        {
            "circuitId": circuit_id,
            "action": "reopen",
            "expectedRevision": accepted_revision,
            "confirmSimulation": True,
        },
    )
    require(
        stale.get("status") == "blocked"
        and stale.get("reason") == "stale_snapshot",
        f"A stale circuit action was not blocked: {stale}",
    )

    reopened = client.invoke_completed(
        "simulate_track_circuit_closure",
        {
            "circuitId": circuit_id,
            "action": "reopen",
            "expectedRevision": current_revision,
            "confirmSimulation": True,
        },
    )
    require(
        reopened.get("status") == "applied_to_simulation"
        and reopened.get("outcome") == "reopened",
        f"WebMCP did not reopen {circuit_id}: {reopened}",
    )
    dialog.get_by_test_id(
        "circuit-close-track-circuit"
    ).wait_for(state="visible")
    after_reopen = client.invoke_completed(
        "inspect_network_state",
        {},
    )
    require(
        after_reopen["decisionRevision"] > current_revision
        and after_reopen["blockedTrackCircuits"]
        == baseline_blocked,
        "Reopening did not restore the simulated network state.",
    )
    dialog.get_by_role(
        "button",
        name="Close dialog",
        exact=True,
    ).click()

    return {
        "circuitId": circuit_id,
        "ui": {
            "close": "browser_click",
            "reopen": "browser_click",
        },
        "webmcp": {
            "close": closed["status"],
            "reopen": reopened["status"],
            "redundant": redundant["reason"],
            "occupied": occupied["reason"],
            "staleRevision": stale["reason"],
            "operatorNoteReturned": False,
        },
        "blockedTrackCircuits": {
            "before": baseline_blocked,
            "closed": after_close["blockedTrackCircuits"],
            "reopened": after_reopen["blockedTrackCircuits"],
        },
    }


def validate_schedule_decision(
    client: WebMcpClient,
) -> dict[str, Any]:
    page = client.page
    page.evaluate(
        "window.location.hash = '/schedules-drivers'"
    )
    file_input = page.locator(
        '[data-testid="schedule-file-input"]'
    )
    file_input.wait_for(state="attached")
    sample_file = (
        PROJECT_ROOT
        / "public"
        / "sample-paris-schedule.csv"
    )
    require(
        sample_file.exists(),
        f"Schedule sample is missing: {sample_file}",
    )
    file_input.set_input_files(str(sample_file))
    page.get_by_text(
        "Schedule imported into the current operational workspace.",
        exact=False,
    ).wait_for()

    inspected = client.invoke_completed(
        "inspect_schedule_plan",
        {"limit": 12},
    )
    require(
        inspected.get("status") == "ok"
        and inspected.get("returned") == 12,
        "Imported schedule inspection is inconsistent.",
    )
    services = inspected.get("services", [])
    require(
        isinstance(services, list) and len(services) > 0,
        "Schedule inspection returned no bounded service.",
    )
    service_id = services[0]["serviceId"]
    before_hash = inspected["planHash"]

    preview = client.invoke_completed(
        "preview_schedule_change",
        {
            "expectedHash": before_hash,
            "kind": "shift_service",
            "serviceId": service_id,
            "deltaMinutes": 5,
        },
    )
    require(
        preview.get("status") == "preview_ready"
        and preview.get("expectedHash") == before_hash
        and preview.get("projectedHash") != before_hash,
        f"Schedule preview was not staged: {preview}",
    )
    preview_id = preview["previewId"]

    impact = client.invoke_completed(
        "evaluate_schedule_impact",
        {
            "expectedHash": before_hash,
            "previewId": preview_id,
        },
    )
    require(
        impact.get("status") == "impact_evaluated"
        and impact.get("hardBlockCount") == 0
        and impact.get("canAuthorize") is True,
        f"Safe schedule impact was not authorizable: {impact}",
    )
    impact_id = impact["impactId"]

    before_authorization = client.invoke_completed(
        "apply_reviewed_schedule_change",
        {
            "expectedHash": before_hash,
            "previewId": preview_id,
            "impactId": impact_id,
        },
    )
    require(
        before_authorization.get("status") == "blocked"
        and before_authorization.get("reason")
        == "human_approval_required",
        "Agent commit bypassed trusted human authorization.",
    )

    authorize = page.get_by_role(
        "button",
        name="Authorize agent application",
    )
    authorize.wait_for(state="visible")
    require(
        authorize.is_enabled(),
        "Safe impact did not enable human authorization.",
    )
    authorize.click()
    page.get_by_text(
        "One-use agent application authorized",
        exact=False,
    ).wait_for()

    committed = client.invoke_completed(
        "apply_reviewed_schedule_change",
        {
            "expectedHash": before_hash,
            "previewId": preview_id,
            "impactId": impact_id,
        },
    )
    require(
        committed.get("status")
        == "committed_to_simulation"
        and committed.get("authorizationConsumed") is True,
        f"Reviewed schedule was not committed: {committed}",
    )
    after_hash = committed["planHash"]
    require(
        after_hash != before_hash,
        "Schedule commit did not advance the exact plan hash.",
    )

    after = client.invoke_completed(
        "inspect_schedule_plan",
        {"limit": 1},
    )
    require(
        after.get("planHash") == after_hash,
        "Committed schedule hash is not visible.",
    )
    stale = client.invoke_completed(
        "preview_schedule_change",
        {
            "expectedHash": before_hash,
            "kind": "shift_service",
            "serviceId": service_id,
            "deltaMinutes": 5,
        },
    )
    require(
        stale.get("status") == "blocked"
        and stale.get("reason") == "stale_schedule",
        "A stale schedule hash was not blocked.",
    )

    hard_preview = client.invoke_completed(
        "preview_schedule_change",
        {
            "expectedHash": after_hash,
            "kind": "reassign_driver",
            "serviceId": service_id,
            "driverToken": "ADC-RA-038",
        },
    )
    require(
        hard_preview.get("status") == "preview_ready",
        f"Hard-block preview was not staged: {hard_preview}",
    )
    hard_impact = client.invoke_completed(
        "evaluate_schedule_impact",
        {
            "expectedHash": after_hash,
            "previewId": hard_preview["previewId"],
        },
    )
    require(
        hard_impact.get("status") == "impact_evaluated"
        and hard_impact.get("hardBlockCount", 0) > 0
        and hard_impact.get("canAuthorize") is False,
        f"Unsafe schedule impact was not blocked: {hard_impact}",
    )
    hard_apply = client.invoke_completed(
        "apply_reviewed_schedule_change",
        {
            "expectedHash": after_hash,
            "previewId": hard_preview["previewId"],
            "impactId": hard_impact["impactId"],
        },
    )
    require(
        hard_apply.get("status") == "blocked"
        and hard_apply.get("reason")
        == "impact_hard_block",
        "An impact with hard blocks reached commit.",
    )
    blocked_authorize = page.get_by_role(
        "button",
        name="Authorize agent application",
    )
    require(
        blocked_authorize.is_disabled(),
        "Hard-blocked impact enabled human authorization.",
    )
    page.get_by_role(
        "button",
        name="Discard draft",
    ).click()

    return {
        "import": "local_csv_loaded",
        "inspect": inspected["status"],
        "preview": preview["status"],
        "impact": impact["status"],
        "beforeAuthorization":
            before_authorization["reason"],
        "trustedAuthorization": "browser_click",
        "commit": committed["status"],
        "authorizationConsumed":
            committed["authorizationConsumed"],
        "staleHash": stale["reason"],
        "hardBlock": hard_apply["reason"],
        "hashChanged": before_hash != after_hash,
        "serviceId": service_id,
    }


def validate_disposal(
    client: WebMcpClient,
    origin: str,
) -> dict[str, Any]:
    probe_name = "validator_lifecycle_probe"
    lifecycle_page = client.page.context.new_page()
    lifecycle = WebMcpClient(
        lifecycle_page,
        client.timeout_seconds,
    )
    try:
        lifecycle_page.goto(
            f"{origin}/#/overview",
            wait_until="domcontentloaded",
        )
        lifecycle.wait_for_tools(EXPECTED_TOOLS)
        lifecycle_page.evaluate(
            """async () => {
              const controller = new AbortController();
              globalThis.__webmcpValidationController = controller;
              await document.modelContext.registerTool(
                {
                  name: 'validator_lifecycle_probe',
                  description:
                    'Validate native WebMCP registration disposal.',
                  inputSchema: {
                    type: 'object',
                    properties: {},
                    additionalProperties: false,
                  },
                  annotations: { readOnlyHint: true },
                  execute: () => ({ status: 'ok' }),
                },
                { signal: controller.signal },
              );
            }"""
        )
        lifecycle.wait_for_tools(EXPECTED_TOOLS | {probe_name})
        registered_names = set(lifecycle.tools)
        removed_before_dispose = len(lifecycle.removed)
        lifecycle_page.evaluate(
            "() => globalThis.__webmcpValidationController.abort()"
        )
        lifecycle.wait_for_tools(EXPECTED_TOOLS)
        disposed = lifecycle.removed[removed_before_dispose:]
        disposed_names = {
            tool["name"]
            for tool in disposed
        }
        require(
            disposed_names == {probe_name},
            (
                "dispose() removed the wrong tools: "
                f"{sorted(disposed_names)}"
            ),
        )
        return {
            "registered": len(
                registered_names - EXPECTED_TOOLS
            ),
            "disposeRemoved": len(disposed_names),
            "remaining": sorted(lifecycle.tools),
        }
    finally:
        lifecycle_page.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--url",
        default=os.environ.get("WEBMCP_URL", DEFAULT_URL),
    )
    parser.add_argument(
        "--browser",
        help="Path to Chromium 151+.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
    )
    parser.add_argument(
        "--headed",
        action="store_true",
    )
    parser.add_argument(
        "--access-code",
        default=os.environ.get("WEBMCP_ACCESS_CODE"),
        help=(
            "Shared code for an authenticated deployment. Prefer the "
            "WEBMCP_ACCESS_CODE environment variable."
        ),
    )
    parser.add_argument(
        "--report",
        type=Path,
        help="Optional JSON report path.",
    )
    return parser.parse_args()


def run_validation(args: argparse.Namespace) -> dict[str, Any]:
    browser_path = find_chromium(args.browser)
    server = start_vite_if_needed(args.url, args.timeout)
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=browser_path,
                headless=not args.headed,
                args=["--enable-features=WebMCP"],
            )
            try:
                context = browser.new_context()
                page = context.new_page()
                browser_errors: list[str] = []
                page.on(
                    "console",
                    lambda message: browser_errors.append(
                        f"console:{message.type}:{message.text}"
                    ) if message.type == "error" else None,
                )
                page.on(
                    "pageerror",
                    lambda error: browser_errors.append(
                        f"page:{error}"
                    ),
                )
                client = WebMcpClient(page, args.timeout)
                version = client.session.send("Browser.getVersion")
                product = version.get("product", "")
                major_text = (
                    product.split("/")[-1]
                    .split(".")[0]
                )
                require(
                    major_text.isdigit()
                    and int(major_text) >= 151,
                    (
                        "Chromium 151+ is required, "
                        f"found {product}."
                    ),
                )

                page.goto(
                    args.url,
                    wait_until="domcontentloaded",
                )
                page.wait_for_function(
                    "document.querySelector('#main-content') || "
                    "document.querySelector('#access-code')",
                    timeout=args.timeout * 1000,
                )
                access_input = page.locator(
                    "#access-code"
                )
                if access_input.is_visible():
                    require(
                        bool(args.access_code),
                        (
                            "The target requires an access code. "
                            "Set WEBMCP_ACCESS_CODE."
                        ),
                    )
                    access_input.fill(args.access_code)
                    page.get_by_role(
                        "button",
                        name="Open operations canvas",
                    ).click()
                    page.locator("#main-content").wait_for(
                        state="visible",
                        timeout=args.timeout * 1000,
                    )
                require(
                    page.evaluate("window.isSecureContext"),
                    "WebMCP requires a secure context.",
                )
                require(
                    page.evaluate(
                        "typeof "
                        "document.modelContext?.registerTool "
                        "=== 'function'"
                    ),
                    (
                        "document.modelContext.registerTool "
                        "is unavailable."
                    ),
                )
                catalog = validate_catalog(client)
                native_network_decision = (
                    validate_native_network_decision(client)
                )
                circuit_closure = (
                    validate_circuit_closure(client)
                )
                invocations = validate_invocations(client)
                schedule_decision = (
                    validate_schedule_decision(client)
                )
                parsed = urlsplit(args.url)
                origin = (
                    f"{parsed.scheme}://{parsed.netloc}"
                )
                lifecycle = validate_disposal(
                    client,
                    origin,
                )
                expected_schema_errors = [
                    error for error in browser_errors
                    if error.startswith(
                        "page:line must be one of "
                    ) or error == (
                        'page:Unexpected input property '
                        '"unexpected".'
                    )
                ]
                expected_development_errors = [
                    error for error in browser_errors
                    if error == (
                        "console:error:Failed to load resource: "
                        "the server responded with a status of 404 (Not Found)"
                    )
                ]
                unexpected_browser_errors = [
                    error for error in browser_errors
                    if error not in expected_schema_errors
                    and error not in expected_development_errors
                ]
                require(
                    not unexpected_browser_errors,
                    (
                        "Unexpected browser errors observed: "
                        f"{unexpected_browser_errors}"
                    ),
                )
                return {
                    "status": "passed",
                    "implementation": (
                        "Chromium native experimental "
                        "WebMCP via CDP"
                    ),
                    "browser": product,
                    "url": args.url,
                    "secureContext": True,
                    "catalog": catalog,
                    "nativeNetworkDecision": native_network_decision,
                    "circuitClosure": circuit_closure,
                    "invocations": invocations,
                    "scheduleDecision": schedule_decision,
                    "lifecycle": lifecycle,
                    "browserErrors": unexpected_browser_errors,
                    "expectedSchemaRejections": expected_schema_errors,
                    "expectedDevelopmentFallbacks": expected_development_errors,
                }
            finally:
                browser.close()
    finally:
        if server is not None:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()


def main() -> int:
    args = parse_args()
    try:
        report = run_validation(args)
    except Exception as error:
        report = {
            "status": "failed",
            "error": (
                f"{type(error).__name__}: {error}"
            ),
        }
        print(
            json.dumps(
                report,
                indent=2,
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 1

    if args.report:
        args.report.parent.mkdir(
            parents=True,
            exist_ok=True,
        )
        args.report.write_text(
            json.dumps(
                report,
                indent=2,
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )
    print(
        json.dumps(
            report,
            indent=2,
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
