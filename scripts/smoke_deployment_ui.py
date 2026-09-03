#!/usr/bin/env python3
"""Smoke-test the authenticated headless decision UI without calling OpenAI."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import time
from pathlib import Path

from playwright.sync_api import Route, sync_playwright


def chromium_path(explicit: str | None) -> str:
    candidates = [
        explicit,
        os.environ.get("WEBMCP_CHROMIUM"),
        shutil.which("chromium"),
        shutil.which("chromium-browser"),
        "/snap/bin/chromium",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    raise RuntimeError("Chromium was not found.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--url",
        default=os.environ.get(
            "WEBMCP_URL",
            "http://127.0.0.1:8787/#/overview",
        ),
    )
    parser.add_argument(
        "--access-code",
        default=os.environ.get("WEBMCP_ACCESS_CODE"),
    )
    parser.add_argument("--browser")
    return parser.parse_args()


def inspect_content_zones(page, expected_root: str) -> int:
    page.locator(f"#{expected_root}").wait_for(state="visible")
    audit = page.evaluate(
        """() => {
            const ids = Array.from(
                document.querySelectorAll('[id^="text-text-"]'),
                element => element.id,
            );
            const counts = new Map();
            for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
            return {
                count: ids.length,
                duplicates: Array.from(counts.entries())
                    .filter(([, count]) => count > 1)
                    .map(([id, count]) => ({ id, count })),
            };
        }"""
    )
    assert audit["count"] >= 2, (expected_root, audit)
    assert audit["duplicates"] == [], (expected_root, audit)
    return audit["count"]


def wait_for_webmcp(page, timeout_ms: int = 15_000) -> None:
    deadline = time.monotonic() + timeout_ms / 1_000
    while time.monotonic() < deadline:
        if page.evaluate(
            """() =>
                typeof document.modelContext?.getTools === 'function' &&
                typeof document.modelContext?.executeTool === 'function'
            """
        ):
            return
        page.wait_for_timeout(50)
    raise AssertionError("Native WebMCP did not become ready before the timeout.")


def main() -> None:
    args = parse_args()
    errors: list[str] = []
    intercepted = {"turn": 0, "reset": 0, "report": 0, "log": 0}

    def intercept_agent(route: Route) -> None:
        if "/api/agent/log?" in route.request.url:
            intercepted["log"] += 1
            entries = [{
                "id": f"LOG-SCROLL-{index:03d}",
                "timestamp": f"2026-08-30T08:{index % 60:02d}:00.000Z",
                "category": "incident" if index % 2 else "generic",
                "model": "gpt-5.6-terra",
                "reasoningEffort": "low",
                "outcome": "completed",
                "durationMs": 750 + index,
                "runId": f"RUN-SCROLL-{index:03d}",
                "inputTokens": 100 + index,
                "outputTokens": 20 + index,
            } for index in range(40)]
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"entries": entries, "total": len(entries)}),
            )
            return
        if route.request.url.endswith("/api/agent/turn"):
            intercepted["turn"] += 1
            # Valid HTTP but deliberately incomplete evidence: this forces the
            # deterministic inspect/search/read procedural fallback without OpenAI.
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "status": "completed",
                    "runId": "deployment-smoke-fallback",
                }),
            )
            return
        if route.request.url.endswith("/api/agent/reset"):
            intercepted["reset"] += 1
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"status": "reset"}),
            )
            return
        if route.request.url.endswith("/api/reports/assist"):
            intercepted["report"] += 1
            payload = route.request.post_data_json or {}
            assert payload.get("reportId")
            assert payload.get("expectedShiftId")
            assert isinstance(payload.get("expectedLogSequence"), int)
            assert "draft" not in payload
            route.continue_()
            return
        route.continue_()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=chromium_path(args.browser),
            headless=True,
            args=["--enable-features=WebMCP"],
        )
        try:
            page = browser.new_page(
                viewport={"width": 1440, "height": 960},
            )
            page.route("**/api/agent/*", intercept_agent)
            page.route("**/api/reports/assist", intercept_agent)
            page.add_init_script(
                """
                window.__parisIccPrintCalled = false;
                window.print = () => { window.__parisIccPrintCalled = true; };
                window.confirm = () => true;
                """
            )
            page.on(
                "console",
                lambda message: errors.append(
                    f"console:{message.type}:{message.text}"
                ) if message.type == "error" else None,
            )
            page.on(
                "pageerror",
                lambda error: errors.append(f"page:{error}"),
            )
            response = page.goto(
                args.url,
                wait_until="domcontentloaded",
            )
            assert response is not None and response.ok
            page.locator("#main-content, #access-code").first.wait_for(
                state="visible"
            )
            access = page.locator("#access-code")
            access_challenge = access.is_visible()
            if access_challenge:
                assert args.access_code, "WEBMCP_ACCESS_CODE is required."
                access.fill(args.access_code)
                page.get_by_role(
                    "button",
                    name="Open operations canvas",
                ).click()

            page.locator("#main-content").wait_for(state="visible")
            wait_for_webmcp(page)
            reset_button = page.get_by_role(
                "button", name="Reset operational workspace"
            )
            reset_button.wait_for(state="visible")
            assert reset_button.inner_text().strip() == "Reset"
            assert "speed-control__reset" in (reset_button.get_attribute("class") or "")
            assert page.locator(".agent-launcher").count() == 0
            assert page.locator(".embedded-agent").count() == 0
            assert page.get_by_role(
                "button",
                name="Open Paris ICC agent",
            ).count() == 0

            configuration_trigger = page.get_by_test_id("open-configuration")
            configuration_trigger.wait_for(state="visible")
            assert configuration_trigger.get_attribute("aria-expanded") == "false"
            configuration_trigger.click()
            configuration_modal = page.get_by_test_id("configuration-modal")
            configuration_modal.wait_for(state="visible")
            assert configuration_trigger.get_attribute("aria-expanded") == "true"
            assert configuration_modal.get_by_role("tab").count() == 4
            assert configuration_modal.get_by_role(
                "tab", name="Agent", exact=True
            ).get_attribute("aria-selected") == "true"
            assert configuration_modal.get_by_role(
                "tab", name="Simulator configuration", exact=True
            ).count() == 1
            assert configuration_modal.get_by_role(
                "tab", name="Agent instruction", exact=True
            ).count() == 1
            assert configuration_modal.locator("#configuration-tab-log").count() == 1

            configuration_model_select = configuration_modal.get_by_test_id(
                "configuration-agent-model"
            )
            configuration_model_select.wait_for(state="visible")
            configuration_model = configuration_model_select.input_value()
            assert configuration_model
            assert configuration_model_select.locator("option").count() >= 4

            reasoning_select = configuration_modal.get_by_test_id(
                "configuration-agent-reasoning-effort"
            )
            reasoning_select.wait_for(state="visible")
            assert reasoning_select.locator("option").count() == 6
            assert reasoning_select.input_value() == "low"

            configuration_model_select.select_option("gpt-5.5-pro")
            assert reasoning_select.locator("option").count() == 3
            assert reasoning_select.input_value() == "high"

            configuration_model_select.select_option("gpt-5.6-sol")
            assert reasoning_select.locator("option").count() == 6
            assert reasoning_select.input_value() == "high"

            configuration_model_select.select_option(configuration_model)
            reasoning_select.select_option("low")
            assert configuration_modal.get_by_text(
                "API key remains on the server", exact=True
            ).is_visible()

            configuration_modal.locator(
                "#configuration-tab-instructions"
            ).click()
            configuration_modal.get_by_role(
                "heading", name="Incident analysis instructions", exact=True
            ).wait_for(state="visible")
            assert configuration_modal.locator(
                ".configuration-instruction-types button"
            ).count() == 9
            infrastructure_type = configuration_modal.get_by_test_id(
                "instruction-type-infrastructure"
            )
            infrastructure_type.click()
            instruction_editor = configuration_modal.get_by_test_id(
                "configuration-agent-incident-instruction"
            )
            instruction_editor.wait_for(state="visible")
            original_instruction = instruction_editor.input_value()
            assert len(original_instruction) >= 40
            save_instructions = configuration_modal.get_by_test_id(
                "save-agent-instructions"
            )
            assert save_instructions.is_disabled()
            instruction_editor.fill(
                original_instruction + " Browser smoke edit."
            )
            assert save_instructions.is_enabled()
            instruction_editor.fill(original_instruction)
            assert save_instructions.is_disabled()
            assert configuration_modal.get_by_test_id(
                "export-agent-instructions"
            ).get_attribute("href") == "/api/configuration/agent-instructions/export"
            assert configuration_modal.get_by_test_id(
                "import-agent-instructions-input"
            ).count() == 1

            configuration_modal.locator("#configuration-tab-log").click()
            configuration_modal.get_by_role(
                "heading", name="Agent execution log", exact=True
            ).wait_for(state="visible")
            refresh_agent_log = configuration_modal.get_by_test_id(
                "refresh-agent-log"
            )
            download_agent_log = configuration_modal.get_by_test_id(
                "download-agent-log"
            )
            refresh_agent_log.wait_for(state="visible")
            download_agent_log.wait_for(state="visible")
            assert download_agent_log.is_enabled()
            assert download_agent_log.get_attribute("href") == "/api/agent/log/download"
            assert download_agent_log.get_attribute("download") is not None
            log_table_wrap = configuration_modal.locator(
                ".configuration-log-table-wrap"
            )
            log_rows = log_table_wrap.locator("tbody tr")
            assert log_rows.count() == 40
            scroll_metrics = log_table_wrap.evaluate(
                """element => ({
                    clientHeight: element.clientHeight,
                    scrollHeight: element.scrollHeight,
                    overflowY: getComputedStyle(element).overflowY,
                })"""
            )
            assert scroll_metrics["overflowY"] in ("auto", "scroll")
            assert scroll_metrics["scrollHeight"] > scroll_metrics["clientHeight"]
            log_table_wrap.evaluate(
                "element => { element.scrollTop = element.scrollHeight; }"
            )
            assert log_table_wrap.evaluate("element => element.scrollTop") > 0
            assert log_table_wrap.locator("thead th").first.evaluate(
                "element => getComputedStyle(element).position"
            ) == "sticky"
            assert intercepted["log"] >= 1
            assert intercepted["turn"] == 0

            configuration_modal.locator(
                "xpath=ancestor::section[@role='dialog']"
            ).get_by_role(
                "button", name="Close dialog", exact=True
            ).click()
            configuration_modal.wait_for(state="detached")
            assert configuration_trigger.get_attribute("aria-expanded") == "false"

            incident_marker = page.locator(
                "[data-presentation-incident-id]"
            ).first
            incident_marker.wait_for(state="visible")
            incident_id = incident_marker.get_attribute(
                "data-presentation-incident-id"
            )
            assert incident_id
            incident_marker.click(force=True)

            modal = page.get_by_test_id(
                "native-incident-decision-modal"
            )
            modal.wait_for(state="visible")
            continue_to_options = modal.get_by_role(
                "button", name="Continue to action options"
            )
            continue_to_options.wait_for(state="visible")
            continue_to_options.click()
            action_cards = modal.locator(".incident-option[data-step-id]")
            action_cards.first.wait_for(state="visible")
            assert action_cards.count() >= 1

            tools = page.evaluate(
                "async () => await document.modelContext.getTools()"
            )
            tool_names = sorted(tool["name"] for tool in tools)
            required_native_tools = {
                "inspect_network_digital_twin",
                "inspect_passenger_flow_impact",
                "inspect_incident_decision_context",
                "inspect_shift_log",
                "search_operational_procedures",
                "get_operational_procedure",
                "apply_reviewed_procedure_step",
            }
            assert len(tool_names) == 22, tool_names
            assert required_native_tools.issubset(tool_names), tool_names

            procedure_evidence = page.evaluate(
                """async (incidentId) => {
                    const tools = await document.modelContext.getTools();
                    const byName = new Map(tools.map(tool => [tool.name, tool]));
                    const invoke = async (name, input) => {
                        try {
                            const value = await document.modelContext.executeTool(
                                byName.get(name),
                                JSON.stringify(input)
                            );
                            return typeof value === "string" ? JSON.parse(value) : value;
                        } catch (error) {
                            throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
                        }
                    };
                    const context = await invoke(
                        "inspect_incident_decision_context",
                        { incidentId }
                    );
                    const incidentCode = context.incident.incidentCode;
                    const search = await invoke(
                        "search_operational_procedures",
                        { incidentCode }
                    );
                    const match = search.matches[0];
                    const procedureResult = await invoke(
                        "get_operational_procedure",
                        {
                            procedureId: match.procedureId,
                            procedureRevision: match.revision,
                            procedureContentHash: match.contentHash,
                        }
                    );
                    return { context, search, match, procedure: procedureResult.procedure };
                }""",
                incident_id,
            )
            context_incident = procedure_evidence["context"]["incident"]
            procedure_search = procedure_evidence["search"]
            procedure_match = procedure_evidence["match"]
            procedure = procedure_evidence["procedure"]
            incident_code = context_incident["incidentCode"]
            assert incident_code.startswith("ICC-INC-"), incident_code
            assert procedure_search["status"] == "procedures_found"
            assert procedure_search["incidentCode"] == incident_code
            assert procedure_search["catalogRevision"]
            assert procedure["procedureId"] == procedure_match["procedureId"]
            assert procedure["revision"] == procedure_match["revision"]
            assert procedure["contentHash"] == procedure_match["contentHash"]
            assert procedure["contentHash"].startswith("sha256:")
            assert "sourceKind" not in procedure_match
            assert "official" not in procedure_match
            assert "sourceKind" not in procedure
            assert "official" not in procedure
            assert "safetyNotice" not in procedure
            assert procedure["steps"]
            assert procedure["normalStateCriteria"]

            displayed_step_ids = action_cards.evaluate_all(
                "elements => elements.map(element => "
                "element.dataset.stepId).sort()"
            )
            assert len(displayed_step_ids) == len(set(displayed_step_ids)), displayed_step_ids
            assert all(displayed_step_ids), displayed_step_ids
            documented_step_ids = {
                step["stepId"] for step in procedure["steps"]
            }
            assert set(displayed_step_ids).issubset(documented_step_ids), (
                displayed_step_ids,
                documented_step_ids,
            )

            review_buttons = modal.get_by_role(
                "button", name="Review this step"
            )
            assert review_buttons.count() == action_cards.count()
            review_buttons.first.wait_for(state="visible")
            action_button_count = review_buttons.count()
            enabled_action_button_count = 1
            assert modal.get_by_text(
                "cited procedural fallback active",
                exact=False,
            ).count() == 1
            assert modal.get_by_text(
                "Agent recommendation and operator choices",
                exact=True,
            ).count() == 1
            modal_text = modal.inner_text()
            forbidden_modal_terms = (
                "simulation", "simulated", "synthetic", "deterministic",
                "scenario", "exercise", "demo-authored",
            )
            assert not any(
                term in modal_text.lower() for term in forbidden_modal_terms
            ), modal_text
            assert incident_code in modal_text
            assert procedure["procedureId"] in modal_text
            assert procedure["revision"] in modal_text
            assert "NOT AN OFFICIAL RATP/IDFM INSTRUCTION" not in modal_text
            assert page.get_by_text(
                "Simulated environment — no real railway system connected.",
                exact=True,
            ).count() >= 1
            assert modal.locator(".procedure-citation").count() == 0

            first_step_id = action_cards.first.get_attribute("data-step-id")
            assert first_step_id in documented_step_ids
            first_step_test_id = f"incident-procedure-step-{first_step_id}"
            review_buttons.first.click()
            execution_card = modal.locator(
                f'[data-testid="{first_step_test_id}"]'
            )
            execution_card.wait_for(state="visible")
            assert execution_card.locator(".procedure-citation").count() == 1
            enabled_action_buttons = execution_card.locator(
                ":scope > footer button:not([disabled])"
            )
            assert enabled_action_buttons.count() == 1
            enabled_action_buttons.first.click()
            approval = page.get_by_test_id("agent-tool-approval")
            approval.wait_for(state="visible")
            assert page.locator(".modal[role=dialog]").count() == 1
            assert page.locator(".modal-backdrop").count() == 1
            assert modal.locator(
                "[data-testid=\"agent-tool-approval\"]"
            ).count() == 1
            assert approval.get_by_text(
                "FINAL OPERATOR CONFIRMATION", exact=False
            ).count() == 1
            approval_text = approval.inner_text()
            assert "pinned in the background" in approval_text
            assert "One-use approval for this procedure step" in approval_text
            assert "confirmSimulation" not in approval_text
            page.get_by_test_id("agent-tool-approve").click()
            approval.wait_for(state="detached")

            completed_first = modal.locator(
                f'[data-testid="incident-completed-step-{first_step_id}"]'
            )
            completed_first.wait_for(state="visible")
            assert completed_first.get_attribute("data-step-status") == "completed"
            assert completed_first.get_by_text("RECORDED OUTCOME", exact=False).count() == 1
            assert first_step_id in completed_first.inner_text()
            assert modal.get_by_role(
                "heading", name="Procedure execution"
            ).is_visible()
            assert modal.locator(".incident-workspace__procedure-ribbon").is_visible()
            assert modal.locator(".incident-procedure-roadmap").is_visible()
            assert modal.locator(".incident-completed-history[open]").is_visible()
            assert modal.get_by_test_id("incident-agent-progress").count() == 0
            assert page.locator(".modal[role=dialog]").count() == 1

            next_enabled = modal.locator(
                "[data-testid^=\"incident-procedure-step-\"] "
                "footer button:not([disabled])"
            ).first
            next_enabled.wait_for(state="visible")
            next_step_test_id = next_enabled.evaluate(
                "button => button.closest(\"article\").dataset.testid"
            )
            next_step_id = next_step_test_id.removeprefix(
                "incident-procedure-step-"
            )
            assert next_step_id != first_step_id
            assert modal.locator(
                f"[data-testid=\"{first_step_test_id}\"]"
            ).count() == 0
            assert next_enabled.is_enabled()
            assert "Complete earlier mandatory step" not in next_enabled.inner_text()

            cookies_before_reload = {
                cookie["name"]: cookie["value"]
                for cookie in page.context.cookies()
            }
            reload_response = page.reload(wait_until="domcontentloaded")
            assert reload_response is not None and reload_response.ok
            page.locator("#main-content").wait_for(state="visible")
            wait_for_webmcp(page)
            cookies_after_reload = {
                cookie["name"]: cookie["value"]
                for cookie in page.context.cookies()
            }
            if access_challenge:
                assert cookies_before_reload
                assert all(
                    cookies_after_reload.get(name) == value
                    for name, value in cookies_before_reload.items()
                )

            persisted_marker = page.locator(
                f'[data-presentation-incident-id="{incident_id}"]'
            ).first
            persisted_marker.wait_for(state="visible")
            persisted_marker.click(force=True)
            persisted_modal = page.get_by_test_id(
                "native-incident-decision-modal"
            )
            persisted_modal.wait_for(state="visible")
            persisted_continue = persisted_modal.get_by_role(
                "button", name="Continue to action options"
            )
            persisted_continue.wait_for(state="visible")
            persisted_continue.click()
            persisted_option = persisted_modal.locator(
                f'.incident-option[data-step-id="{next_step_id}"]'
            )
            persisted_option.wait_for(state="visible")
            assert persisted_modal.locator(
                f'.incident-option[data-step-id="{first_step_id}"]'
            ).count() == 0
            persisted_option.get_by_role(
                "button", name="Review this step"
            ).click()
            persisted_actions = persisted_modal.locator(
                "[data-testid^=\"incident-procedure-step-\"]"
            )
            persisted_actions.first.wait_for(state="visible")
            assert persisted_modal.locator(
                f"[data-testid=\"{first_step_test_id}\"]"
            ).count() == 0
            persisted_completed = persisted_modal.locator(
                f'[data-testid="incident-completed-step-{first_step_id}"]'
            )
            persisted_completed.wait_for(state="visible")
            assert persisted_completed.get_attribute("data-step-status") == "completed"
            assert persisted_completed.get_by_text(
                "RECORDED OUTCOME", exact=False
            ).count() == 1

            persisted_context = page.evaluate(
                """async (incidentId) => {
                    const tools = await document.modelContext.getTools();
                    const inspect = tools.find(
                        tool => tool.name === "inspect_incident_decision_context"
                    );
                    const value = await document.modelContext.executeTool(
                        inspect,
                        JSON.stringify({ incidentId })
                    );
                    return typeof value === "string" ? JSON.parse(value) : value;
                }""",
                incident_id,
            )
            completed_step_ids = persisted_context["incident"][
                "procedureExecution"
            ]["completedStepIds"]
            assert first_step_id in completed_step_ids, completed_step_ids

            persisted_next = persisted_modal.locator(
                f'[data-testid="incident-procedure-step-{next_step_id}"] '
                "footer button:not([disabled])"
            )
            persisted_next.wait_for(state="visible")
            assert persisted_next.is_enabled()
            assert "Complete earlier mandatory step" not in persisted_next.inner_text()

            persisted_next.click()
            approval.wait_for(state="visible")
            page.get_by_test_id("agent-tool-reject").click()
            persisted_modal.get_by_text(
                "Procedure step not applied",
                exact=True,
            ).wait_for(state="visible")

            page.wait_for_timeout(100)
            assert (
                intercepted["turn"] == 0 and intercepted["reset"] == 0
            ) or (
                intercepted["turn"] >= 2 and intercepted["reset"] >= 2
            ), intercepted
            assert not errors, errors

            page.get_by_role(
                "button",
                name="Close dialog",
            ).click()
            modal.wait_for(state="detached")

            base_url = args.url.split("#", 1)[0]

            page.goto(
                f"{base_url}#/operations-log",
                wait_until="domcontentloaded",
            )
            page.locator("#text-text-operations-log-page").wait_for(
                state="visible"
            )
            log_row_ids = page.locator(
                "[data-log-entry-id]"
            ).evaluate_all(
                "elements => elements.map(element => "
                "element.dataset.logEntryId)"
            )
            shift_before_report = page.evaluate(
                """async () => {
                    const response = await fetch('/api/operations/snapshot');
                    return (await response.json()).shift;
                }"""
            )
            expected_log_ids = [
                entry["id"] for entry in sorted(
                    shift_before_report["logs"],
                    key=lambda entry: entry["sequence"],
                    reverse=True,
                )
            ]
            assert log_row_ids == expected_log_ids, (
                log_row_ids,
                expected_log_ids,
            )
            assert page.locator(
                "[data-log-entry-id] time"
            ).count() == len(log_row_ids)
            assert page.get_by_text(
                "procedure-step-recorded",
                exact=True,
            ).count() >= 1

            page.goto(
                f"{base_url}#/shift-report",
                wait_until="domcontentloaded",
            )
            report_document = page.locator(
                "#text-text-shift-report-document"
            )
            report_document.wait_for(state="visible")
            assert report_document.get_attribute("contenteditable") == "true"
            for formatting_label in (
                "Bold", "Italic", "Underline", "Strikethrough",
                "Heading", "Bulleted list", "Numbered list",
            ):
                assert page.get_by_role(
                    "button", name=formatting_label, exact=True
                ).is_enabled()
            assert page.get_by_role(
                "button", name="Save", exact=True
            ).count() == 0

            operator_note = "Operator smoke note persisted without Save."
            page.evaluate(
                """(note) => {
                    const editor = document.querySelector(
                        '#text-text-shift-report-document'
                    );
                    editor.insertAdjacentHTML('beforeend', `<p>${note}</p>`);
                    editor.dispatchEvent(new InputEvent('input', {
                        bubbles: true,
                        inputType: 'insertText',
                        data: note,
                    }));
                }""",
                operator_note,
            )
            autosave_deadline = time.monotonic() + 10
            while time.monotonic() < autosave_deadline:
                if page.evaluate(
                    """async (note) => {
                        const response = await fetch('/api/operations/snapshot');
                        const snapshot = await response.json();
                        return snapshot.shift.report.contentHtml.includes(note);
                    }""",
                    operator_note,
                ):
                    break
                page.wait_for_timeout(100)
            else:
                raise AssertionError("Report autosave was not persisted before timeout.")
            page.goto(f"{base_url}#/overview", wait_until="domcontentloaded")
            page.locator("#text-text-overview-page").wait_for(state="visible")
            page.goto(
                f"{base_url}#/shift-report",
                wait_until="domcontentloaded",
            )
            report_document = page.locator(
                "#text-text-shift-report-document"
            )
            report_document.wait_for(state="visible")
            restored_report_text = report_document.inner_text()
            restored_report_html = page.evaluate(
                """async () => {
                    const response = await fetch('/api/operations/snapshot');
                    return (await response.json()).shift.report.contentHtml;
                }"""
            )
            assert operator_note in restored_report_text, {
                "serverContainsNote": operator_note in restored_report_html,
                "serverTail": restored_report_html[-240:],
                "documentTail": restored_report_text[-240:],
            }

            page.get_by_role(
                "button",
                name="Agent draft from shift logs",
                exact=True,
            ).click()
            report_document.get_by_text(
                "End-of-shift operational report",
                exact=False,
            ).wait_for(state="visible")
            page.get_by_text(
                "verified chronology was prepared",
                exact=False,
            ).wait_for(state="visible")
            page.get_by_text(
                "WebMCP",
                exact=False,
            ).wait_for(state="visible")
            assert intercepted["report"] == 1, intercepted

            page.reload(wait_until="domcontentloaded")
            page.locator("#main-content").wait_for(state="visible")
            report_document = page.locator(
                "#text-text-shift-report-document"
            )
            report_document.wait_for(state="visible")
            assert "End-of-shift operational report" in report_document.inner_text()

            page.get_by_role(
                "button",
                name="Freeze & print PDF",
                exact=True,
            ).click()
            page.locator(
                '#text-text-shift-report-document[data-report-status="frozen"]'
            ).wait_for(state="visible")
            page.wait_for_function("() => window.__parisIccPrintCalled === true")
            report_document = page.locator(
                "#text-text-shift-report-document"
            )
            assert report_document.get_attribute("contenteditable") == "false"
            assert page.get_by_role(
                "button", name="Print / save PDF", exact=True
            ).is_enabled()
            assert page.get_by_role(
                "button", name="Bold", exact=True
            ).is_disabled()
            frozen_shift = page.evaluate(
                """async () => {
                    const response = await fetch('/api/operations/snapshot');
                    return (await response.json()).shift;
                }"""
            )
            assert frozen_shift["report"]["status"] == "frozen"
            frozen_event_types = {
                entry["eventType"] for entry in frozen_shift["logs"]
            }
            assert "report-agent-draft-applied" in frozen_event_types
            assert "shift-report-frozen" in frozen_event_types

            content_zone_routes = {
                "/overview": "text-text-overview-page",
                "/passenger-flow": "text-text-passenger-flow-page",
                "/simulator": "text-text-simulator-page",
                "/procedures": "text-text-procedures-page",
                "/schedules-drivers": "text-text-schedules-page",
                "/incidents": "text-text-incidents-page",
                "/regulation": "text-text-regulation-page",
                "/power": "text-text-power-page",
                "/operations-log": "text-text-operations-log-page",
                "/shift-report": "text-text-shift-report-page",
            }
            content_zone_counts: dict[str, int] = {}
            for route_path, expected_root in content_zone_routes.items():
                page.goto(f"{base_url}#{route_path}", wait_until="domcontentloaded")
                content_zone_counts[route_path] = inspect_content_zones(
                    page, expected_root
                )

            print(json.dumps({
                "status": "passed",
                "url": args.url,
                "authenticated": True,
                "accessChallenge": access_challenge,
                "nativeWebMcpToolCount": len(tool_names),
                "incidentId": incident_id,
                "incidentDecisionModal": True,
                "decisionMode": "procedure-grounded-controlled-fallback",
                "incidentCode": incident_code,
                "catalogRevision": procedure_search["catalogRevision"],
                "procedureId": procedure["procedureId"],
                "procedureRevision": procedure["revision"],
                "procedureContentHash": procedure["contentHash"],
                "citedStepCount": len(displayed_step_ids),
                "citedStepIds": displayed_step_ids,
                "actionButtonCount": action_button_count,
                "enabledActionButtonCount": enabled_action_button_count,
                "chatLauncherAbsent": True,
                "chatPanelAbsent": True,
                "configurationModalVerified": True,
                "configurationTabCount": 4,
                "configurationModel": configuration_model,
                "configurationAgentInstructionsVisible": True,
                "configurationAgentLogVisible": True,
                "configurationAgentLogDownloadVisible": True,
                "agentTurnIntercepted": intercepted["turn"],
                "agentResetIntercepted": intercepted["reset"],
                "operatorApprovalVisible": True,
                "operatorApprovedStepId": first_step_id,
                "workflowStayedInModal": True,
                "completedStepSummaryVisible": True,
                "nextStepUnlocked": True,
                "nextStepId": next_step_id,
                "reloadPersistenceVerified": True,
                "sameSessionCookieAfterReload": (
                    not access_challenge or bool(cookies_before_reload)
                ),
                "incidentReopenedAfterReload": True,
                "recordedStepPresentAfterReload": True,
                "nextStepUnlockedAfterReload": True,
                "operatorRejectedWrite": True,
                "shiftLogNewestFirst": True,
                "reportAutosavePersisted": True,
                "reportAgentDraftApplied": intercepted["report"] == 1,
                "reportFrozen": True,
                "reportPrintInvoked": True,
                "externalModelCalled": False,
                "modalClosed": True,
                "contentZoneRouteCounts": content_zone_counts,
                "contentZoneIdsUnique": True,
                "browserErrors": errors,
            }, indent=2))
        finally:
            browser.close()


if __name__ == "__main__":
    main()
