#!/usr/bin/env python3

import json
import math
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173/#/overview"
artifact = Path(
    sys.argv[2] if len(sys.argv) > 2 else "artifacts/native-network-semantic-zoom.png"
)
artifact.parent.mkdir(parents=True, exist_ok=True)
detail_artifact = artifact.with_name(f"{artifact.stem}-detail{artifact.suffix}")
runtime_detail_artifact = artifact.with_name(
    f"{artifact.stem}-runtime-detail{artifact.suffix}"
)
report_artifact = artifact.with_name("native-network-ui-validation.json")
errors: list[str] = []


def unique_object_count(page, selector: str) -> int:
    return page.locator(".native-map__artwork").evaluate(
        """(root, selector) => new Set(
          Array.from(root.querySelectorAll(selector), node =>
            node.getAttribute("data-object-id") || node.id
          ).filter(Boolean)
        ).size""",
        selector,
    )


def intersection_fraction(inner: dict[str, float], outer: dict[str, float]) -> float:
    left = max(inner["x"], outer["x"])
    top = max(inner["y"], outer["y"])
    right = min(inner["x"] + inner["width"], outer["x"] + outer["width"])
    bottom = min(inner["y"] + inner["height"], outer["y"] + outer["height"])
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    area = inner["width"] * inner["height"]
    return intersection / area if area > 0 else 0.0


def assert_monotonic(values: list[float], tolerance: float = 0.5) -> None:
    assert all(
        right + tolerance >= left
        for left, right in zip(values, values[1:])
    ), values


def record_console_error(prefix, message) -> None:
    if message.type != "error":
        return
    if message.text == "Failed to load resource: the server responded with a status of 404 (Not Found)":
        return
    errors.append(f"{prefix}:{message.type}:{message.text}")


def record_http_error(prefix, response) -> None:
    if response.status < 400 or response.url.endswith(("/api/config", "/api/session")):
        return
    errors.append(f"{prefix}:{response.status}:{response.url}")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        executable_path="/snap/bin/chromium",
        headless=True,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    page = browser.new_page(viewport={"width": 1600, "height": 1100})
    page.route(
        "**/api/configuration",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({
                "agent": {
                    "enabled": True,
                    "model": "gpt-5.6-terra",
                    "defaultModel": "gpt-5.6-terra",
                    "defaultReasoningEffort": "medium",
                    "allowedModels": ["gpt-5.6-terra"],
                    "models": [{
                        "id": "gpt-5.6-terra",
                        "label": "GPT-5.6 Terra",
                        "family": "GPT-5.6",
                        "reasoningEfforts": [
                            "none", "low", "medium", "high", "xhigh", "max"
                        ],
                        "defaultReasoningEffort": "medium",
                        "recommended": True,
                    }],
                    "reasoningEffort": "low",
                    "updatedAt": None,
                },
                "log": {
                    "count": 0,
                    "downloadUrl": "/api/agent/log/download",
                },
            }),
        ),
    )
    page.on("console", lambda message: record_console_error("console", message))
    page.on("response", lambda response: record_http_error("console-http", response))
    page.on("pageerror", lambda error: errors.append(f"page:{error}"))
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_selector(".native-map__artwork svg[data-runtime-interactive='true']")
    page.wait_for_selector(
        ".native-map__artwork g[data-runtime-object-host]", state="attached"
    )
    page.wait_for_timeout(600)

    native_svg = page.locator(".native-map__artwork svg[data-runtime-interactive='true']")
    runtime_structure = native_svg.evaluate(
        """root => {
          const objects = Array.from(root.querySelectorAll(
            "g.native-station[data-object-id],g.native-station-component[data-object-id],g.native-interstation[data-object-id]"
          ));
          const hosts = Array.from(root.querySelectorAll("g[data-runtime-object-host]"));
          const invalidObjects = objects.filter(object => {
            const directHosts = Array.from(object.children).filter(child =>
              child.matches("g[data-runtime-object-host]") &&
              child.dataset.runtimeObjectHost === object.dataset.objectId
            );
            return directHosts.length !== 1 || directHosts[0] !== object.lastElementChild;
          });
          const markers = Array.from(root.querySelectorAll(
            "[data-runtime-entity]"
          ));
          const misplacedMarkers = markers.filter(marker => {
            const host = marker.closest("g[data-runtime-object-host]");
            const object = marker.closest(
              "g.native-station,g.native-station-component,g.native-interstation"
            );
            return !host || !object || host.parentNode !== object ||
              host.dataset.runtimeObjectHost !== object.dataset.objectId ||
              marker.dataset.anchorObjectId !== object.dataset.objectId;
          });
          const expectedLayer = {
            incident: "incidents",
            train: "trains",
            "delay-cluster": "state",
            "object-context": "context"
          };
          const wrongLayerMarkers = markers.filter(marker =>
            marker.closest("[data-runtime-layer]")?.dataset.runtimeLayer !==
              expectedLayer[marker.dataset.runtimeEntity]
          );
          const foreground = root.querySelector(
            ":scope > g[data-runtime-operational-foreground='true']"
          );
          const presentations = Array.from(root.querySelectorAll(
            "[data-runtime-presentation]"
          ));
          const invalidPresentations = presentations.filter(presentation => {
            const anchor = root.querySelector(
              `#${CSS.escape(presentation.dataset.runtimeAnchorRef || "")}`
            );
            const foregroundLayer = presentation.closest(
              "[data-runtime-foreground-layer]"
            )?.dataset.runtimeForegroundLayer;
            return !anchor ||
              anchor.dataset.runtimeEntity !== presentation.dataset.runtimePresentation ||
              anchor.dataset.anchorObjectId !== presentation.dataset.anchorObjectId ||
              foregroundLayer !== expectedLayer[presentation.dataset.runtimePresentation];
          });
          const foregroundLayers = foreground
            ? Array.from(foreground.children).map(layer =>
                layer.getAttribute("data-runtime-foreground-layer")
              )
            : [];
          const interstationOwners = objects.filter(object =>
            object.classList.contains("native-interstation")
          );
          const occupiedOwners = interstationOwners.filter(object =>
            object.classList.contains("native-object--occupied")
          );
          const occupancyMismatches = interstationOwners.filter(object => {
            const host = Array.from(object.children).find(child =>
              child.matches("g[data-runtime-object-host]")
            );
            const expected = Number(host?.dataset.runtimeTrainCount || "0") > 0;
            return expected !== object.classList.contains("native-object--occupied") ||
              object.dataset.runtimeOccupation !== (expected ? "occupied" : "clear");
          });
          const occupiedSampleOwner = occupiedOwners.find(object =>
            !object.classList.contains("native-object--affected") &&
            !object.classList.contains("native-object--selected")
          );
          const occupiedSamplePath = occupiedSampleOwner?.querySelector(
            ":scope > .interstation-visual"
          );
          const freeSampleOwner = occupiedSampleOwner
            ? interstationOwners.find(object =>
                object.dataset.lineCode === occupiedSampleOwner.dataset.lineCode &&
                !object.classList.contains("native-object--occupied") &&
                !object.classList.contains("native-object--affected") &&
                !object.classList.contains("native-object--selected")
              )
            : null;
          const freeSamplePath = freeSampleOwner?.querySelector(
            ":scope > .interstation-visual"
          );
          return {
            objects: objects.length,
            hosts: hosts.length,
            invalid_objects: invalidObjects.map(node => node.dataset.objectId),
            misplaced_markers: misplacedMarkers.length,
            wrong_layer_markers: wrongLayerMarkers.length,
            owner_button_roles: objects.filter(node => node.getAttribute("role") === "button").length,
            wrong_namespace: hosts.filter(node =>
              node.namespaceURI !== "http://www.w3.org/2000/svg"
            ).length,
            invalid_layers: hosts.filter(host => {
              const layers = Array.from(host.children).filter(child =>
                child.matches("g[data-runtime-layer]")
              );
              return layers.length !== 4 ||
                layers.map(layer => layer.dataset.runtimeLayer).join(" ") !==
                  "state trains context incidents" ||
                layers.some(layer => layer.dataset.runtimeLayerOwner !== host.dataset.runtimeObjectHost);
            }).length,
            semantic_entities: markers.length,
            presentations: presentations.length,
            invalid_presentations: invalidPresentations.length,
            presentation_root_count: foreground ? 1 : 0,
            foreground_is_last: root.lastElementChild === foreground,
            foreground_layers: foregroundLayers,
            host_count_attribute: Number(root.dataset.runtimeObjectHostCount),
            aria_hidden: root.getAttribute("aria-hidden"),
            occupied_interstations: occupiedOwners.length,
            occupancy_mismatches: occupancyMismatches.map(node => node.dataset.objectId),
            occupied_sample: occupiedSamplePath && freeSamplePath ? {
              occupied_source_stroke: occupiedSamplePath.getAttribute("stroke"),
              free_source_stroke: freeSamplePath.getAttribute("stroke"),
              occupied_computed_stroke: getComputedStyle(occupiedSamplePath).stroke,
              free_computed_stroke: getComputedStyle(freeSamplePath).stroke,
              occupied_filter: getComputedStyle(occupiedSamplePath).filter,
              free_filter: getComputedStyle(freeSamplePath).filter
            } : null
          };
        }"""
    )
    expected_runtime_structure = {
        "objects": 951,
        "hosts": 951,
        "invalid_objects": [],
        "misplaced_markers": 0,
        "wrong_layer_markers": 0,
        "owner_button_roles": 0,
        "wrong_namespace": 0,
        "invalid_layers": 0,
        "invalid_presentations": 0,
        "presentation_root_count": 1,
        "foreground_is_last": True,
        "foreground_layers": ["state", "trains", "context", "incidents"],
        "host_count_attribute": 951,
        "aria_hidden": None,
    }
    for key, expected in expected_runtime_structure.items():
        assert runtime_structure[key] == expected, (key, runtime_structure)
    assert runtime_structure["semantic_entities"] == runtime_structure["presentations"], (
        runtime_structure
    )
    assert runtime_structure["occupied_interstations"] > 0, runtime_structure
    assert runtime_structure["occupancy_mismatches"] == [], runtime_structure
    occupied_sample = runtime_structure["occupied_sample"]
    assert occupied_sample is not None, runtime_structure
    assert (
        occupied_sample["occupied_source_stroke"]
        == occupied_sample["free_source_stroke"]
    ), occupied_sample
    assert (
        occupied_sample["occupied_computed_stroke"]
        == occupied_sample["free_computed_stroke"]
    ), occupied_sample
    assert occupied_sample["occupied_filter"] != "none", occupied_sample
    assert occupied_sample["free_filter"] == "none", occupied_sample
    global_overlay_count = page.locator(
        ".native-map__stage > .native-map__overlay"
    ).count()
    assert global_overlay_count == 0
    counts = {
        "lines": page.locator(".native-map__artwork g.native-line").count(),
        "canonical_stations": int(native_svg.get_attribute("data-station-count")),
        "station_wrappers": page.locator(".native-map__artwork g.native-station").count(),
        "station_components": unique_object_count(page, "[data-object-id^='station-']"),
        "interstations": unique_object_count(page, "[data-object-id^='interstation-']"),
        "incidents": page.locator("[data-incident-id]").count(),
        "runtime_object_hosts": page.locator(".native-map__artwork g[data-runtime-object-host]").count(),
        "overview_train_markers": page.locator(".native-map__artwork [data-train-id]").count(),
    }
    assert counts["lines"] == 21, counts
    # The map declares and wraps 390 canonical station records. The 484 unique
    # component object IDs preserve line-specific artwork at interchanges.
    assert counts["canonical_stations"] == 390, counts
    assert counts["station_wrappers"] == 390, counts
    assert counts["station_components"] == 484, counts
    assert counts["interstations"] == 467, counts
    assert counts["runtime_object_hosts"] == 951, counts
    assert counts["incidents"] == 3, counts
    assert counts["overview_train_markers"] == 0, counts
    assert (
        page.locator("[data-testid='native-network-stage']").get_attribute(
            "data-semantic-level"
        )
        == "overview"
    )

    palette = page.evaluate(
        """() => {
          const value = selector => getComputedStyle(document.querySelector(selector));
          return {
            body: value("body").backgroundColor,
            sidebar: value(".sidebar").backgroundColor,
            topbar: value(".topbar").backgroundColor,
            panel: value(".native-network-panel").backgroundColor
          };
        }"""
    )
    for name, color in palette.items():
        numbers = [int(value) for value in color.replace("rgba(", "").replace("rgb(", "")
                   .replace(")", "").split(",")[:3]]
        assert sum(numbers) >= 500, (name, color, palette)

    # Marker geometry is an explicit screen-space contract: the native map can
    # zoom to 8x, while icons and labels grow progressively within bounded
    # density profiles. A dedicated page keeps these measurements independent
    # from the movement and selections exercised by the rest of this validator.
    marker_page = browser.new_page(viewport={"width": 1600, "height": 1100})
    marker_page.on("console", lambda message: record_console_error("marker-console", message))
    marker_page.on("response", lambda response: record_http_error("marker-console-http", response))
    marker_page.on("pageerror", lambda error: errors.append(f"marker-page:{error}"))
    marker_page.goto(url, wait_until="domcontentloaded")
    marker_page.wait_for_selector(
        ".native-map__artwork svg[data-runtime-interactive='true']"
    )
    marker_page.wait_for_selector("[data-presentation-incident-id]")
    marker_page.wait_for_timeout(250)
    marker_root_width = float(
        marker_page.locator(".native-map__artwork svg").get_attribute("viewBox").split()[2]
    )
    marker_incident_id = marker_page.locator("[data-incident-id]").first.get_attribute(
        "data-incident-id"
    )
    assert marker_incident_id

    def marker_snapshot(
        target_zoom: float,
        train_id: str | None = None,
    ) -> dict[str, object]:
        return marker_page.evaluate(
            """([rootWidth, targetZoom, incidentId, trainId]) => {
              const rect = node => {
                if (!node) return null;
                const box = node.getBoundingClientRect();
                return {
                  x: box.x, y: box.y,
                  width: box.width, height: box.height
                };
              };
              const root = document.querySelector('.native-map__artwork svg');
              const stage = document.querySelector('[data-testid="native-network-stage"]');
              const incident = document.querySelector(
                `[data-presentation-incident-id="${CSS.escape(incidentId)}"]`
              );
              const train = trainId
                ? document.querySelector(`[data-presentation-train-id="${CSS.escape(trainId)}"]`)
                : null;
              const viewBox = root.getAttribute('viewBox').trim().split(/\\s+/).map(Number);
              const detailOwners = Array.from(
                root.querySelectorAll('[data-presentation-train-id] .native-train-marker__detail')
              ).filter(detail => {
                const style = getComputedStyle(detail);
                return style.display !== 'none' && style.visibility !== 'hidden' &&
                  Number(style.opacity) > 0.5;
              }).map(detail =>
                detail.closest('[data-presentation-train-id]')?.dataset.presentationTrainId
              );
              return {
                target_zoom: targetZoom,
                actual_zoom: rootWidth / viewBox[2],
                semantic_level: stage.dataset.semanticLevel,
                stage: rect(stage),
                incident_id: incident.dataset.presentationIncidentId,
                incident_icon_density: Number(incident.dataset.iconPixelDensity),
                incident_tag_density: Number(incident.dataset.tagPixelDensity),
                incident_symbol: rect(incident.querySelector('.native-incident-marker__symbol')),
                incident_plate: rect(incident.querySelector('.native-incident-marker__plate')),
                incident_tag: rect(incident.querySelector('.native-object-tag__plate')),
                train_count: root.querySelectorAll('[data-presentation-train-id]').length,
                train_id: train?.dataset.presentationTrainId ?? null,
                train_class: train?.getAttribute('class') ?? null,
                train_detail_opacity: train?.querySelector('.native-train-marker__detail')
                  ? getComputedStyle(train.querySelector('.native-train-marker__detail')).opacity
                  : null,
                train_detail_has_selected_ancestor: Boolean(
                  train?.querySelector('.native-train-marker__detail')
                    ?.closest('.native-train-marker--selected')
                ),
                train_body_density: train ? Number(train.dataset.bodyPixelDensity) : null,
                train_detail_density: train ? Number(train.dataset.detailPixelDensity) : null,
                train_body: rect(train?.querySelector('.native-train-marker__body')),
                train_detail: rect(train?.querySelector('.native-train-marker__detail rect')),
                train_detail_count: detailOwners.length,
                train_detail_owners: detailOwners.filter(Boolean)
              };
            }""",
            [marker_root_width, target_zoom, marker_incident_id, train_id],
        )

    def zoom_in_marker_page(clicks: int) -> None:
        for _ in range(clicks):
            marker_page.evaluate(
                "document.querySelector('button[aria-label=\"Zoom in\"]').click()"
            )
            marker_page.wait_for_timeout(90)

    zoom_samples: dict[str, dict[str, object]] = {}
    zoom_samples["1"] = marker_snapshot(1)
    zoom_in_marker_page(1)
    operations_sample = marker_snapshot(1.3)
    zoom_in_marker_page(3)
    detail_before_train_selection = marker_snapshot(2.4)
    assert detail_before_train_selection["semantic_level"] == "detail"
    assert detail_before_train_selection["train_detail_count"] == 0, (
        "Train evidence tags must be selected-only",
        detail_before_train_selection["train_detail_owners"],
    )
    marker_train_id = marker_page.evaluate(
        """() => {
          const stage = document.querySelector('[data-testid="native-network-stage"]')
            .getBoundingClientRect();
          const center = { x: stage.x + stage.width / 2, y: stage.y + stage.height / 2 };
          return Array.from(document.querySelectorAll('[data-presentation-train-id]'))
            .map(train => {
              const box = train.querySelector('.native-train-marker__body').getBoundingClientRect();
              const x = box.x + box.width / 2;
              const y = box.y + box.height / 2;
              const intersects = box.x < stage.x + stage.width &&
                box.x + box.width > stage.x &&
                box.y < stage.y + stage.height &&
                box.y + box.height > stage.y;
              return {
                id: train.dataset.presentationTrainId,
                distance: Math.hypot(x - center.x, y - center.y),
                intersects
              };
            })
            .filter(candidate => candidate.intersects)
            .sort((left, right) => left.distance - right.distance)[0]?.id ?? null;
        }"""
    )
    assert marker_train_id, "No visible train was available for marker-size validation"
    marker_page.locator(
        f"[data-presentation-train-id='{marker_train_id}']"
    ).dispatch_event("click")
    marker_page.wait_for_function(
        """trainId => {
          const train = document.querySelector(
            `[data-presentation-train-id="${CSS.escape(trainId)}"]`
          );
          const detail = train?.querySelector('.native-train-marker__detail');
          return train?.classList.contains('native-train-marker--selected') &&
            detail && Number(getComputedStyle(detail).opacity) > 0.95;
        }""",
        arg=marker_train_id,
    )
    zoom_samples["2.4"] = marker_snapshot(2.4, marker_train_id)
    zoom_in_marker_page(1)
    zoom_samples["4"] = marker_snapshot(4, marker_train_id)
    marker_page.locator(".native-network-panel").screenshot(
        path=str(runtime_detail_artifact)
    )
    zoom_in_marker_page(3)
    zoom_samples["8"] = marker_snapshot(8, marker_train_id)

    assert math.isclose(zoom_samples["1"]["actual_zoom"], 1, abs_tol=0.01)
    assert 2.4 <= zoom_samples["2.4"]["actual_zoom"] <= 3.05
    assert 3.4 <= zoom_samples["4"]["actual_zoom"] <= 4.4
    assert 7.95 <= zoom_samples["8"]["actual_zoom"] <= 8.01
    assert zoom_samples["1"]["semantic_level"] == "overview"
    assert zoom_samples["1"]["incident_tag"] is None
    assert zoom_samples["1"]["train_count"] == 0
    assert operations_sample["semantic_level"] == "operations"
    assert operations_sample["incident_tag"] is not None
    assert operations_sample["train_count"] == 42
    assert operations_sample["train_detail_count"] == 0

    detail_samples = [zoom_samples[key] for key in ("2.4", "4", "8")]
    geometry_contracts = (
        ("incident_plate", "incident_icon_density", 32, 32),
        ("incident_tag", "incident_tag_density", 176, 52),
        ("train_body", "train_body_density", 44, 18),
        ("train_detail", "train_detail_density", 150, 32),
    )
    for sample in detail_samples:
        assert sample["semantic_level"] == "detail", sample
        assert sample["train_detail_count"] == 1, (
            sample["target_zoom"], sample["train_detail_owners"],
            sample["train_class"], sample["train_detail_opacity"],
            sample["train_detail_has_selected_ancestor"]
        )
        assert sample["train_detail_owners"] == [marker_train_id], sample
        for rectangle_key, density_key, native_width, native_height in geometry_contracts:
            rectangle = sample[rectangle_key]
            density = sample[density_key]
            assert rectangle is not None and density is not None, (rectangle_key, sample)
            width_ratio = rectangle["width"] / (native_width * density)
            height_ratio = rectangle["height"] / (native_height * density)
            assert 0.94 <= width_ratio <= 1.06, (rectangle_key, width_ratio, sample)
            assert 0.94 <= height_ratio <= 1.06, (rectangle_key, height_ratio, sample)

        assert 28 <= sample["incident_plate"]["width"] <= 52, sample
        assert 150 <= sample["incident_tag"]["width"] <= 230, sample
        assert 40 <= sample["incident_tag"]["height"] <= 72, sample
        assert 38 <= sample["train_body"]["width"] <= 65, sample
        assert 14 <= sample["train_body"]["height"] <= 30, sample
        assert 145 <= sample["train_detail"]["width"] <= 215, sample
        assert 26 <= sample["train_detail"]["height"] <= 50, sample
        assert intersection_fraction(sample["incident_plate"], sample["stage"]) >= 0.99, sample
        assert intersection_fraction(sample["incident_tag"], sample["stage"]) >= 0.95, sample
        # A moving train may legitimately leave the incident-centred viewport
        # while the test zooms further. If its centre is still inside, at least
        # half of the body and most of its evidence card must remain visible.
        train_body = sample["train_body"]
        train_body_center = (
            train_body["x"] + train_body["width"] / 2,
            train_body["y"] + train_body["height"] / 2,
        )
        stage = sample["stage"]
        train_center_inside = (
            stage["x"] <= train_body_center[0] <= stage["x"] + stage["width"] and
            stage["y"] <= train_body_center[1] <= stage["y"] + stage["height"]
        )
        if train_center_inside:
            assert intersection_fraction(train_body, stage) >= 0.45, sample
            assert intersection_fraction(
                sample["train_detail"], sample["stage"]
            ) >= 0.85, sample
        elif train_body_center[1] > stage["y"] + stage["height"]:
            assert sample["train_detail"]["y"] < train_body["y"], sample

    density_limits = {
        "incident_icon_density": 1.44,
        "incident_tag_density": 1.171,
        "train_body_density": 1.271,
        "train_detail_density": 1.311,
    }
    for density_key, maximum in density_limits.items():
        values = [float(sample[density_key]) for sample in detail_samples]
        assert_monotonic(values, tolerance=0.002)
        assert max(values) <= maximum, (density_key, values)
    for rectangle_key in ("incident_plate", "incident_tag", "train_body", "train_detail"):
        assert_monotonic(
            [float(sample[rectangle_key]["width"]) for sample in detail_samples]
        )

    marker_growth = {
        "incident_icon": (
            detail_samples[-1]["incident_plate"]["width"] /
            detail_samples[0]["incident_plate"]["width"]
        ),
        "incident_tag": (
            detail_samples[-1]["incident_tag"]["width"] /
            detail_samples[0]["incident_tag"]["width"]
        ),
        "train_body": (
            detail_samples[-1]["train_body"]["width"] /
            detail_samples[0]["train_body"]["width"]
        ),
        "train_detail": (
            detail_samples[-1]["train_detail"]["width"] /
            detail_samples[0]["train_detail"]["width"]
        ),
    }
    assert 1.15 <= marker_growth["incident_icon"] <= 1.6, marker_growth
    assert 1.06 <= marker_growth["incident_tag"] <= 1.35, marker_growth
    assert 1.10 <= marker_growth["train_body"] <= 1.45, marker_growth
    assert 1.06 <= marker_growth["train_detail"] <= 1.35, marker_growth
    painter_order_validation = marker_page.evaluate(
        """incidentId => {
          const presentation = document.querySelector(
            `[data-presentation-incident-id="${CSS.escape(incidentId)}"]`
          );
          const plate = presentation.querySelector('.native-object-tag__plate');
          const box = plate.getBoundingClientRect();
          let samples = 0;
          let covered = 0;
          let unresolved = 0;
          const blockers = new Set();
          for (let row = 1; row <= 5; row += 1) {
            for (let column = 1; column <= 11; column += 1) {
              const x = box.x + box.width * column / 12;
              const y = box.y + box.height * row / 6;
              const stack = document.elementsFromPoint(x, y);
              const presentationIndex = stack.findIndex(node => presentation.contains(node));
              samples += 1;
              if (presentationIndex < 0) {
                unresolved += 1;
                continue;
              }
              const nativeBlocker = stack.slice(0, presentationIndex).find(node =>
                node instanceof SVGElement &&
                !node.closest('[data-runtime-operational-foreground]')
              );
              if (nativeBlocker) {
                covered += 1;
                blockers.add(nativeBlocker.id || nativeBlocker.tagName);
              }
            }
          }
          return {
            samples,
            covered,
            unresolved,
            blockers: Array.from(blockers)
          };
        }""",
        marker_incident_id,
    )
    assert painter_order_validation["samples"] == 55, painter_order_validation
    assert painter_order_validation["unresolved"] == 0, painter_order_validation
    assert painter_order_validation["covered"] == 0, painter_order_validation
    marker_page.close()

    # The deterministic M3bis fleet shares one native interstation from ticks
    # 9 through 15. This exercises real portal siblings instead of a cloned DOM
    # fixture and verifies stable, centred lane allocation.
    lane_page = browser.new_page(viewport={"width": 1600, "height": 1100})
    lane_page.on("console", lambda message: record_console_error("lane-console", message))
    lane_page.on("response", lambda response: record_http_error("lane-console-http", response))
    lane_page.on("pageerror", lambda error: errors.append(f"lane-page:{error}"))
    lane_page.goto(url, wait_until="domcontentloaded")
    lane_page.wait_for_selector("[data-presentation-incident-id]")
    lane_page.evaluate(
        "document.querySelector('button[aria-label=\"Zoom in\"]').click()"
    )
    lane_page.wait_for_function(
        """() => Array.from(
          document.querySelectorAll('g[data-runtime-object-host]')
        ).some(host => {
          const declared = Number(host.dataset.runtimeTrainCount);
          const rendered = host.querySelectorAll(
            ':scope > [data-runtime-layer="trains"] > [data-train-id]'
          ).length;
          return declared > 1 && rendered === declared;
        })""",
        timeout=16_000,
    )
    lane_validation = lane_page.evaluate(
        """() => {
          const host = Array.from(
            document.querySelectorAll('g[data-runtime-object-host]')
          ).find(candidate => Number(candidate.dataset.runtimeTrainCount) > 1);
          const trains = Array.from(host.querySelectorAll(
            ':scope > [data-runtime-layer="trains"] > [data-train-id]'
          ));
          return {
            owner_id: host.dataset.runtimeObjectHost,
            declared_count: Number(host.dataset.runtimeTrainCount),
            train_detail_count: Array.from(document.querySelectorAll(
              '[data-presentation-train-id] .native-train-marker__detail'
            )).filter(detail => Number(getComputedStyle(detail).opacity) > 0.5).length,
            trains: trains.map(train => {
              const presentation = document.querySelector(
                `[data-presentation-train-id="${CSS.escape(train.dataset.trainId)}"]`
              );
              const body = presentation.querySelector('.native-train-marker__body')
                .getBoundingClientRect();
              return {
                id: train.dataset.trainId,
                lane_offset: Number(train.dataset.laneOffset),
                body_density: Number(presentation.dataset.bodyPixelDensity),
                body: {
                  x: body.x, y: body.y,
                  width: body.width, height: body.height
                }
              };
            })
          };
        }"""
    )
    assert lane_validation["owner_id"] == "interstation-M3BIS-71828--71860", lane_validation
    assert lane_validation["declared_count"] == 2, lane_validation
    assert lane_validation["train_detail_count"] == 0, lane_validation
    lane_trains = sorted(lane_validation["trains"], key=lambda train: train["id"])
    expected_lane_offsets = [
        (index - (len(lane_trains) - 1) / 2) * 28
        for index in range(len(lane_trains))
    ]
    actual_lane_offsets = [train["lane_offset"] for train in lane_trains]
    assert all(
        math.isclose(actual, expected, abs_tol=0.01)
        for actual, expected in zip(actual_lane_offsets, expected_lane_offsets)
    ), (actual_lane_offsets, expected_lane_offsets)
    assert math.isclose(sum(actual_lane_offsets), 0, abs_tol=0.01), actual_lane_offsets
    first_lane_body = lane_trains[0]["body"]
    second_lane_body = lane_trains[1]["body"]
    lane_overlap = min(
        intersection_fraction(first_lane_body, second_lane_body),
        intersection_fraction(second_lane_body, first_lane_body),
    )
    first_center = (
        first_lane_body["x"] + first_lane_body["width"] / 2,
        first_lane_body["y"] + first_lane_body["height"] / 2,
    )
    second_center = (
        second_lane_body["x"] + second_lane_body["width"] / 2,
        second_lane_body["y"] + second_lane_body["height"] / 2,
    )
    lane_center_distance = math.dist(first_center, second_center)
    assert lane_overlap <= 0.65, (lane_overlap, lane_validation)
    assert lane_center_distance >= min(
        first_lane_body["height"], second_lane_body["height"]
    ) * 0.65, (lane_center_distance, lane_validation)
    lane_validation["expected_lane_offsets"] = expected_lane_offsets
    lane_validation["overlap_fraction"] = lane_overlap
    lane_validation["center_distance_pixels"] = lane_center_distance
    lane_page.close()

    first_incident = page.locator("[data-incident-id]").first
    first_incident_id = first_incident.get_attribute("data-incident-id")
    assert first_incident_id, counts
    first_incident_presentation = page.locator(
        f"[data-presentation-incident-id='{first_incident_id}']"
    )
    incident_parent_before = first_incident.evaluate(
        "node => node.closest('g.native-interstation,g.native-station')?.dataset.objectId"
    )
    first_incident_presentation.click(force=True)
    decision_modal = page.get_by_test_id("native-incident-decision-modal")
    decision_modal.wait_for(state="visible", timeout=60_000)
    continue_to_options = decision_modal.get_by_role(
        "button", name="Continue to action options"
    )
    continue_to_options.wait_for(state="visible", timeout=60_000)
    continue_to_options.click()
    decision_options = decision_modal.locator(".incident-option")
    decision_options.first.wait_for(state="visible", timeout=60_000)
    decision_action_count = decision_options.count()
    decision_review_count = decision_modal.get_by_role(
        "button", name="Review this step"
    ).count()
    decision_modal_text = decision_modal.inner_text()
    assert first_incident_id in decision_modal_text
    assert "Agent proposal for the operator" in decision_modal_text
    assert decision_action_count >= 2, decision_action_count
    assert decision_review_count == decision_action_count, (
        decision_review_count,
        decision_action_count,
    )
    decision_modal.get_by_role("button", name="Review this step").first.click()
    execution_card = decision_modal.locator(
        "[data-testid^='incident-procedure-step-']"
    )
    execution_card.wait_for(state="visible", timeout=60_000)
    assert execution_card.locator(".procedure-citation").count() == 1
    assert execution_card.locator(":scope > footer button").count() == 1
    decision_modal.locator("xpath=ancestor::section[@role='dialog']").get_by_role(
        "button", name="Close dialog", exact=True
    ).click()
    decision_modal.wait_for(state="detached")
    page.wait_for_timeout(200)
    level_after_incident = page.locator(
        "[data-testid='native-network-stage']"
    ).get_attribute("data-semantic-level")
    assert level_after_incident in {"operations", "detail"}, level_after_incident
    focused_incident = page.locator(f"[data-incident-id='{first_incident_id}']")
    incident_parent_after = focused_incident.evaluate(
        "node => node.closest('g.native-interstation,g.native-station')?.dataset.objectId"
    )
    assert incident_parent_after == incident_parent_before
    assert focused_incident.get_attribute("data-semantic-density") == level_after_incident
    focused_incident_presentation = page.locator(
        f"[data-presentation-incident-id='{first_incident_id}']"
    )
    assert focused_incident_presentation.get_attribute(
        "data-runtime-anchor-ref"
    ) == focused_incident.get_attribute("id")
    marker_box = focused_incident_presentation.bounding_box()
    assert marker_box, first_incident_id
    hit_points = [
        (marker_box["x"] + marker_box["width"] * x_ratio,
         marker_box["y"] + marker_box["height"] * y_ratio)
        for x_ratio, y_ratio in [(0.1, 0.5), (0.18, 0.42), (0.18, 0.58)]
    ]
    incident_hit_count = page.evaluate(
        """([points, incidentId]) => points.filter(([x, y]) =>
          document.elementFromPoint(x, y)?.closest("[data-presentation-incident-id]")
            ?.dataset.presentationIncidentId === incidentId
        ).length""",
        [hit_points, first_incident_id],
    )
    assert incident_hit_count >= 1, (incident_hit_count, marker_box)
    train_count = page.locator(".native-map__artwork [data-train-id]").count()
    assert train_count >= 2, train_count
    train_binding_errors = native_svg.evaluate(
        """root => Array.from(root.querySelectorAll("[data-train-id]")).filter(train => {
          const owner = train.closest("g.native-interstation,g.native-station");
          const host = train.closest("g[data-runtime-object-host]");
          const layer = train.closest("g[data-runtime-layer]");
          const locationType = train.dataset.operationalLocationType;
          const ownerKindMatches = locationType === "station"
            ? owner?.classList.contains("native-station")
            : locationType === "interstation"
              ? owner?.classList.contains("native-interstation")
              : false;
          return !owner || !host || !ownerKindMatches ||
            owner.dataset.objectId !== train.dataset.anchorObjectId ||
            host.dataset.runtimeObjectHost !== train.dataset.anchorObjectId ||
            layer?.dataset.runtimeLayer !== "trains" ||
            !train.dataset.operationalLocationId;
        }).map(train => train.dataset.trainId)"""
    )
    assert train_binding_errors == [], train_binding_errors
    inspector = page.locator(".native-map__inspector").inner_text()
    assert "WEBMCP TOOL PATH" in inspector, inspector
    assert "decision rev." in inspector.lower(), inspector

    first_train_id = page.locator(".native-map__artwork [data-train-id]").first.get_attribute(
        "data-train-id"
    )
    assert first_train_id
    first_train = page.locator(f".native-map__artwork [data-train-id='{first_train_id}']")
    first_train_presentation = page.locator(
        f".native-map__artwork [data-presentation-train-id='{first_train_id}']"
    )
    state_before = page.evaluate(
        """trainId => {
          const train = document.querySelector(`[data-train-id="${trainId}"]`);
          return {
            location: train.dataset.operationalLocationType + ":" + train.dataset.operationalLocationId,
            transform: train.getAttribute("transform")
          };
        }""",
        first_train_id,
    )
    page.wait_for_timeout(1100)
    state_after = page.evaluate(
        """trainId => {
          const train = document.querySelector(`[data-train-id="${trainId}"]`);
          return {
            location: train.dataset.operationalLocationType + ":" + train.dataset.operationalLocationId,
            transform: train.getAttribute("transform")
          };
        }""",
        first_train_id,
    )
    if state_before["location"] == state_after["location"]:
        assert state_before["transform"] == state_after["transform"], (state_before, state_after)
    sampled_points = []
    for _ in range(6):
        binding_state = page.evaluate(
            """trainId => {
              const train = document.querySelector(`[data-train-id="${trainId}"]`);
              if (!train) return { valid: false, train: trainId, missing: true };
              const owner = train.closest("g.native-interstation,g.native-station");
              const host = train.closest("g[data-runtime-object-host]");
              const layer = train.closest("g[data-runtime-layer]");
              const locationType = train.dataset.operationalLocationType;
              const ownerKindMatches = locationType === "station"
                ? owner?.classList.contains("native-station")
                : locationType === "interstation"
                  ? owner?.classList.contains("native-interstation")
                  : false;
              return {
                valid: Boolean(owner && host && ownerKindMatches &&
                  owner.dataset.objectId === train.dataset.anchorObjectId &&
                  host.dataset.runtimeObjectHost === train.dataset.anchorObjectId &&
                  layer?.dataset.runtimeLayer === "trains"),
                train: train.dataset.trainId,
                locationType,
                locationId: train.dataset.operationalLocationId,
                owner: owner?.dataset.objectId,
                host: host?.dataset.runtimeObjectHost,
                nativeX: train.dataset.nativeX,
                nativeY: train.dataset.nativeY,
                duplicates: document.querySelectorAll(`[data-train-id="${train.dataset.trainId}"]`).length,
                connected: train.isConnected
              };
            }""",
            first_train_id,
        )
        assert binding_state["valid"], binding_state
        assert binding_state["duplicates"] == 1, binding_state
        sampled_points.append({
            "location": binding_state["locationType"] + ":" + binding_state["locationId"],
            "point": (
                float(binding_state["nativeX"]),
                float(binding_state["nativeY"]),
            ),
        })
        page.wait_for_timeout(550)
    points_by_location = {}
    for sample in sampled_points:
        assert sample["location"].split(":", 1)[0] in {"station", "interstation"}, sample
        assert all(math.isfinite(coordinate) for coordinate in sample["point"]), sample
        previous = points_by_location.setdefault(sample["location"], sample["point"])
        assert math.dist(previous, sample["point"]) < 0.01, (previous, sample)
    assert points_by_location, sampled_points
    page.locator(".native-network-panel").screenshot(path=str(detail_artifact))
    # The sampled train can be outside the incident-focused viewport. Dispatching
    # still validates the portal event and guards against delegated owner clicks.
    first_train_presentation.dispatch_event("click")
    page.wait_for_timeout(100)
    train_inspector = page.locator(".native-map__inspector").inner_text()
    assert "TRAIN ·" in train_inspector, train_inspector

    page.get_by_label("Find station or IDFM code").fill("Nation")
    page.get_by_role("button", name="Locate").click()
    page.wait_for_timeout(150)
    assert (
        page.locator("[data-testid='native-network-stage']").get_attribute(
            "data-semantic-level"
        )
        == "detail"
    )
    assert "Nation" in page.locator(".native-map__inspector").inner_text()
    assert page.locator(".native-map__artwork .native-object--selected").count() >= 1

    station_component = page.locator(
        ".native-map__artwork g.native-station-component[data-object-id]"
    ).first
    component_station_code = station_component.get_attribute("data-station-code")
    component_station_name = station_component.get_attribute("data-name")
    assert component_station_code and component_station_name
    station_component.dispatch_event("click")
    page.wait_for_timeout(100)
    component_inspector = page.locator(".native-map__inspector").inner_text()
    assert "STATION · " + component_station_code in component_inspector, component_inspector
    assert component_station_name in component_inspector, component_inspector
    assert page.locator(
        ".native-map__artwork g.native-interstation[role='button'] [role='button']"
    ).count() == 0

    page.get_by_role("button", name="RER A–E").click()
    assert page.locator(".native-map__lines > button").count() == 6
    page.get_by_role("button", name="All 21 lines").click()
    assert page.locator(".native-map__lines > button").count() == 22

    page.get_by_role("button", name="Fit", exact=True).click()
    assert (
        page.locator("[data-testid='native-network-stage']").get_attribute(
            "data-semantic-level"
        )
        == "overview"
    )
    assert page.locator(".native-map__artwork [data-train-id]").count() == 0

    page.locator(".native-network-panel").screenshot(path=str(artifact))
    global_overflow = page.evaluate(
        "document.documentElement.scrollWidth > document.documentElement.clientWidth"
    )
    assert not global_overflow

    responsive = {}
    for width, height in [(1024, 900), (768, 820), (390, 780)]:
        page.set_viewport_size({"width": width, "height": height})
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector(".native-map__artwork svg[data-runtime-interactive='true']")
        page.wait_for_selector(
            ".native-map__artwork g[data-runtime-object-host]", state="attached"
        )
        page.wait_for_timeout(250)
        overflow = page.evaluate(
            "document.documentElement.scrollWidth > document.documentElement.clientWidth"
        )
        responsive_incident_plate = page.locator(
            "[data-presentation-incident-id] .native-incident-marker__plate"
        ).first.bounding_box()
        assert responsive_incident_plate, width
        responsive[str(width)] = {
            "global_horizontal_overflow": overflow,
            "semantic_level": page.locator(
                "[data-testid='native-network-stage']"
            ).get_attribute("data-semantic-level"),
            "incidents": page.locator("[data-incident-id]").count(),
            "incident_plate_width": responsive_incident_plate["width"],
        }
        assert not overflow, responsive
        assert responsive[str(width)]["semantic_level"] == "overview"
        assert responsive[str(width)]["incidents"] == 3
        assert 25 <= responsive[str(width)]["incident_plate_width"] <= 32, responsive
        assert page.locator(".native-map__artwork g[data-runtime-object-host]").count() == 951

    route_report = {}
    route_titles = {
        "simulator": "Simulation data",
        "passenger-flow": "Passenger flow",
        "schedules-drivers": "Schedules",
        "incidents": "Incident management",
        "regulation": "regulation",
        "power": "power",
        "scada": "SCADA",
        "bus-services": "Bus",
        "rolling-stock": "Rolling stock",
        "procedures": "Procedures",
    }
    for width, height in [(1440, 960), (390, 780)]:
        page.set_viewport_size({"width": width, "height": height})
        for route, title_fragment in route_titles.items():
            page.evaluate(f"window.location.hash = '/{route}'")
            page.wait_for_timeout(180)
            heading = page.locator("main h1").first.inner_text()
            overflow = page.evaluate(
                "document.documentElement.scrollWidth > document.documentElement.clientWidth"
            )
            route_report[f"{width}:{route}"] = {
                "heading": heading,
                "global_horizontal_overflow": overflow,
            }
            assert title_fragment.lower() in heading.lower(), route_report
            assert not overflow, route_report
            if width == 390:
                assert page.locator(".sidebar__nav .nav-item").count() == 12, route_report

    page.set_viewport_size({"width": 1440, "height": 960})
    page.evaluate("window.location.hash = '/simulator'")
    page.wait_for_selector(".simulator-panel")
    simview_link = page.locator(".simview-link[href='#/simulator']")
    assert simview_link.count() == 1
    assert simview_link.inner_text().strip() == "SimView"
    assert simview_link.get_attribute("href") == "#/simulator"
    assert "simview-link--active" in (simview_link.get_attribute("class") or "")
    assert page.locator(".simulator-tabs [role='tab']").count() == 8
    assert page.locator("[data-testid='export-simulation-configuration']").count() == 0
    assert page.locator("[data-testid='import-simulation-configuration']").count() == 0
    page.evaluate(
        """() => {
          window.__simulationConfigurationBlob = null;
          const originalCreateObjectURL = URL.createObjectURL.bind(URL);
          URL.createObjectURL = (blob) => {
            window.__simulationConfigurationBlob = blob;
            return originalCreateObjectURL(blob);
          };
        }"""
    )
    page.get_by_test_id("open-configuration").click()
    configuration_modal = page.get_by_test_id("configuration-modal")
    configuration_modal.wait_for(state="visible")
    assert configuration_modal.get_by_role("tab").count() == 3
    configuration_modal.get_by_role(
        "tab", name="Simulator configuration", exact=True
    ).click()
    configuration_modal.get_by_role(
        "heading", name="Simulator baseline", exact=True
    ).wait_for(state="visible")
    with page.expect_download() as download_info:
        configuration_modal.get_by_test_id(
            "export-simulation-configuration"
        ).click()
    configuration_download = download_info.value
    assert configuration_download.suggested_filename.endswith(".json")
    assert configuration_download.failure() is None
    configuration_contents = page.evaluate(
        "() => window.__simulationConfigurationBlob?.text()"
    )
    assert configuration_contents
    configuration_artifact = artifact.with_name("simulation-configuration-round-trip.json")
    configuration_artifact.write_text(configuration_contents, encoding="utf-8")
    configuration_document = json.loads(configuration_contents)
    assert configuration_document["schema"] == "paris-icc-simulation-configuration-v1"
    assert all(
        incident.get("occurrenceTime")
        for incident in configuration_document["nativeNetwork"]["incidents"]
    )
    assert all(
        incident.get("occurrenceTime")
        for incident in configuration_document["detailedCorridor"]["incidents"]
    )
    configuration_modal.locator(".configuration-file-input").set_input_files({
        "name": configuration_artifact.name,
        "mimeType": "application/json",
        "buffer": configuration_contents.encode("utf-8"),
    })
    configuration_modal.get_by_test_id(
        "simulation-configuration-preview"
    ).wait_for(state="visible")
    configuration_modal.get_by_test_id(
        "install-simulation-configuration"
    ).click()
    configuration_modal.get_by_text(
        "installed as the new Reset baseline", exact=False
    ).wait_for(state="visible")
    configuration_modal.locator(
        "xpath=ancestor::section[@role='dialog']"
    ).get_by_role(
        "button", name="Close dialog", exact=True
    ).click()
    configuration_modal.wait_for(state="detached")
    page.wait_for_function(
        "() => document.querySelector('[data-testid=\"open-configuration\"]')?.getAttribute('aria-expanded') === 'false'",
    )
    page.locator("#simulator-tab-stations").click()
    assert page.locator(".simulator-table tbody tr").count() == 50
    page.locator(".simulator-pagination button").last.click()
    assert "Page 2" in page.locator(".simulator-pagination").inner_text()
    page.locator("#simulator-tab-power").click()
    page.wait_for_function(
        "() => document.querySelectorAll('.simulator-table tbody tr').length === 8"
    )
    assert page.locator(".simulator-table tbody tr").count() == 8
    page.locator("#simulator-tab-trains").click()
    page.locator(".simulator-search input").fill("RERB-T02")
    assert page.locator(".simulator-table tbody tr").count() == 1
    location_text = page.locator(".simulator-table tbody tr td").nth(2).inner_text()
    assert "Station" in location_text or "Interstation" in location_text
    simulator_registry_report = {
        "header_link": "SimView",
        "configuration_schema": configuration_document["schema"],
        "export_filename": configuration_download.suggested_filename,
        "incident_occurrence_times": True,
        "round_trip_import": True,
        "tabs": 8,
        "station_page_size": 50,
        "power_sections": 8,
        "train_search_result": "RERB-T02",
        "discrete_location_visible": True,
    }

    page.set_viewport_size({"width": 1440, "height": 960})
    page.evaluate("window.location.hash = '/overview'")
    page.wait_for_selector(".native-map__artwork svg[data-runtime-interactive='true']")
    presentation_overflow = page.evaluate(
        "document.documentElement.scrollWidth > document.documentElement.clientWidth"
    )
    chat_surface_absent = (
        page.locator(".agent-console").count() == 0
        and page.locator(".agent-launcher").count() == 0
        and page.locator(".embedded-agent").count() == 0
        and page.locator(".embedded-agent--open").count() == 0
        and page.get_by_text("Agent settings", exact=True).count() == 0
    )
    assert chat_surface_absent
    assert not presentation_overflow
    webmcp_viewport_report = {
        "network_overview_map_only": True,
        "incident_decision_modal_ready": True,
        "incident_decision_action_count": decision_action_count,
        "chat_surface_absent": chat_surface_absent,
        "global_horizontal_overflow": presentation_overflow,
    }

    page.set_viewport_size({"width": 1440, "height": 960})
    page.evaluate("window.location.hash = '/incidents'")
    page.wait_for_selector(".native-decision-queue .incident-row")
    assert page.locator(".native-decision-queue .incident-row").count() == 3
    deep_link_row = page.locator(".native-decision-queue .incident-row").nth(1)
    deep_link_incident = deep_link_row.locator(".incident-row__main small").inner_text().split(" · ")[0]
    deep_link_row.click()
    page.wait_for_selector(".native-map__artwork svg[data-runtime-interactive='true']")
    deep_link_modal = page.get_by_test_id("native-incident-decision-modal")
    deep_link_modal.wait_for(state="visible", timeout=60_000)
    deep_link_continue = deep_link_modal.get_by_role(
        "button", name="Continue to action options"
    )
    deep_link_continue.wait_for(state="visible", timeout=60_000)
    deep_link_continue.click()
    deep_link_modal.locator(".incident-option").first.wait_for(
        state="visible", timeout=60_000
    )
    assert deep_link_incident in deep_link_modal.inner_text()
    assert deep_link_modal.locator(".incident-option").count() >= 2
    deep_link_modal.get_by_role("button", name="Review this step").first.click()
    assert deep_link_modal.locator(
        "[data-testid^='incident-procedure-step-'] > footer button"
    ).count() == 1
    deep_link_modal.locator("xpath=ancestor::section[@role='dialog']").get_by_role(
        "button", name="Close dialog", exact=True
    ).click()
    deep_link_modal.wait_for(state="detached")
    page.wait_for_function(
        "incidentId => document.querySelector('.native-map__inspector')?.textContent?.includes(incidentId)",
        arg=deep_link_incident,
    )
    assert deep_link_incident in page.url
    assert page.locator("[data-testid='native-network-stage']").get_attribute(
        "data-semantic-level"
    ) in {"operations", "detail"}

    browser.close()

report = {
    **counts,
    "level_after_incident_click": level_after_incident,
    "runtime_structure": runtime_structure,
    "global_operational_overlay_count": global_overlay_count,
    "incident_parent_persisted": incident_parent_after == incident_parent_before,
    "runtime_marker_zoom": {
        "selected_train_id": marker_train_id,
        "operations_sample": operations_sample,
        "detail_before_train_selection": detail_before_train_selection,
        "samples": zoom_samples,
        "growth_ratios": marker_growth,
        "painter_order": painter_order_validation,
        "lane_allocation": lane_validation,
    },
    "incident_hit_points": incident_hit_count,
    "operational_train_markers": train_count,
    "train_binding_errors": train_binding_errors,
    "train_binding_verified_samples": len(sampled_points),
    "train_event_selected_inspector": "TRAIN ·" in train_inspector,
    "station_component_context_resolved": component_station_code,
    "train_location_model": "discrete-station-interstation",
    "train_discrete_locations_sampled": sorted(points_by_location),
    "train_stable_within_location": True,
    "palette": palette,
    "global_horizontal_overflow": global_overflow,
    "browser_errors": errors,
    "responsive": responsive,
    "routes": route_report,
    "simulator_registry": simulator_registry_report,
    "webmcp_viewport": webmcp_viewport_report,
    "native_incident_deep_link": deep_link_incident,
    "screenshot": str(artifact),
    "detail_screenshot": str(detail_artifact),
    "runtime_detail_screenshot": str(runtime_detail_artifact),
    "report_file": str(report_artifact),
}
assert not errors, report
report_artifact.write_text(
    json.dumps(report, indent=2, ensure_ascii=False) + "\n",
    encoding="utf-8",
)
print(json.dumps(report, indent=2, ensure_ascii=False))
