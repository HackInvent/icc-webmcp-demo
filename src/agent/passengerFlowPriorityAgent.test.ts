import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createNativeNetworkController } from "../rail/nativeSimulation";
import { createNativeSimulationTools } from "../webmcp/nativeTools";
import {
  analyzePassengerFlowPriorities,
  PASSENGER_FLOW_IMPACT_TOOL,
  type PassengerFlowPriorityProgress,
} from "./passengerFlowPriorityAgent";

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

beforeAll(() => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { modelContext: undefined },
  });
});

afterAll(() => {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

describe("Passenger Flow WebMCP priority agent", () => {
  it("reads the current in-page tool and returns the verified top three when OpenAI is disabled", async () => {
    const controller = createNativeNetworkController({ scenarioId: "multi-event", speed: 1 });
    for (let second = 0; second < 120; second += 1) controller.tick();
    const tools = createNativeSimulationTools(controller);
    const impactTool = tools.find((tool) => tool.name === PASSENGER_FLOW_IMPACT_TOOL)!;
    const execute = vi.spyOn(impactTool, "execute");
    const progress: PassengerFlowPriorityProgress[] = [];

    const result = await analyzePassengerFlowPriorities({
      line: "ALL",
      expectedToolNames: tools.map((tool) => tool.name),
      inPageTools: tools,
      modelEnabled: false,
      signal: new AbortController().signal,
      onProgress: (status) => progress.push(status),
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      { line: "ALL" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(progress).toEqual(["discovering", "inspecting"]);
    expect(result.transport).toBe("in-page");
    expect(result.modelAssisted).toBe(false);
    expect(result.priorities).toHaveLength(3);
    expect(result.priorities.map((priority) => priority.incidentId)).toEqual([
      "INC-RERA-SIGNAL",
      "INC-M14-POWER",
      "INC-M13-WORKS",
    ]);
    expect(result.priorities[0].waitingQueuePassengers)
      .toBeGreaterThan(result.priorities[1].waitingQueuePassengers);
    expect(result.priorities[0].recommendation).toContain("Open the controlled response workflow");
  });
});
