export class Analytics {
  track(_event: unknown): void {
    // Telemetry is disabled for the local-only renderer.
  }
}
