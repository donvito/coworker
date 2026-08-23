import { describe, expect, it } from "vitest";
import { isoWithLocalOffset } from "@shared/time";

describe("schedule time context", () => {
  it("carries an offset that agrees with the wall clock it prints", () => {
    const now = new Date();
    const stamp = isoWithLocalOffset(now);
    // The whole point: parsing the string back must land on the same instant.
    // A UTC wall clock wearing a local offset would not.
    expect(Math.abs(new Date(stamp).getTime() - now.getTime())).toBeLessThan(1_000);
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  it("stays consistent for a relative time the model would compute from it", () => {
    const now = new Date("2026-08-23T15:17:33Z");
    const inTenMinutes = new Date(now.getTime() + 10 * 60_000);
    // Adding to the printed instant must stay ahead of it, whatever the host
    // offset is. The old UTC-instant-plus-zone-name pairing failed this.
    expect(new Date(isoWithLocalOffset(inTenMinutes)).getTime()).toBeGreaterThan(
      new Date(isoWithLocalOffset(now)).getTime(),
    );
  });
});
