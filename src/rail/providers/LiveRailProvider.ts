import type { RailDataProvider, RailSnapshot } from "../domain";

export class LiveRailProvider implements RailDataProvider {
  readonly mode = "live" as const;

  constructor(private readonly endpoint: string | null) {}

  async loadSnapshot(): Promise<RailSnapshot> {
    if (!this.endpoint) {
      throw new Error("No live endpoint is configured. The cockpit remains in simulation mode.");
    }
    throw new Error("The live connector must validate and normalize the operator snapshot.");
  }

  subscribe(): () => void {
    return () => undefined;
  }
}
