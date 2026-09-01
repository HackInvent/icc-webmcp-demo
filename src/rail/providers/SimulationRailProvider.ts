import type { RailDataProvider, RailSnapshot } from "../domain";
import { createInitialSnapshot } from "../scenario";

export class SimulationRailProvider implements RailDataProvider {
  readonly mode = "simulation" as const;

  async loadSnapshot(): Promise<RailSnapshot> {
    return createInitialSnapshot();
  }

  subscribe(): () => void {
    return () => undefined;
  }
}
