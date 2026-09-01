import { describe, expect, it } from "vitest";
import { detailPath, nativeIncidentPath, parseHash, pathForPage, procedurePath } from "./navigation";

describe("hash navigation", () => {
  it("parses canonical pages and encoded detail identifiers", () => {
    expect(parseHash("#/power")).toEqual({ page: "power" });
    expect(parseHash("#/simulator")).toEqual({ page: "simulator" });
    expect(parseHash("#/passenger-flow")).toEqual({ page: "passenger-flow" });
    expect(parseHash("#/procedures")).toEqual({ page: "procedures" });
    expect(parseHash("#/operations-log")).toEqual({ page: "log" });
    expect(parseHash("#/shift-report")).toEqual({ page: "report" });
    expect(parseHash(`#${detailPath("train", "MI 09/42")}`)).toEqual({
      page: "detail",
      detailType: "train",
      id: "MI 09/42",
    });
    expect(pathForPage("schedules")).toBe("/schedules-drivers");
    expect(pathForPage("simulator")).toBe("/simulator");
    expect(pathForPage("passenger-flow")).toBe("/passenger-flow");
    expect(pathForPage("procedures")).toBe("/procedures");
    expect(pathForPage("log")).toBe("/operations-log");
    expect(pathForPage("report")).toBe("/shift-report");
    const nativePath = nativeIncidentPath("INC-RERA SIGNAL/42");
    expect(nativePath).toBe("/overview/incident/INC-RERA%20SIGNAL%2F42");
    expect(parseHash(`#${nativePath}`)).toEqual({
      page: "overview",
      nativeIncidentId: "INC-RERA SIGNAL/42",
    });
    const documentPath = procedurePath("ICC-PROC/SCADA 01");
    expect(documentPath).toBe("/procedures/ICC-PROC%2FSCADA%2001");
    expect(parseHash(`#${documentPath}`)).toEqual({
      page: "procedures",
      procedureId: "ICC-PROC/SCADA 01",
    });
  });

  it("falls back safely for unknown and malformed external hashes", () => {
    expect(parseHash("#/totally-unknown")).toEqual({ page: "overview" });
    expect(parseHash("#/agent-settings")).toEqual({ page: "overview" });
    expect(parseHash("#/details/train/%E0%A4%A")).toEqual({ page: "overview" });
  });
});
