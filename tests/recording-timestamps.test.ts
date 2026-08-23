import { describe, expect, it } from "vitest";
import { shiftIsoTimestamp, shiftTimestampsDeep } from "@shared/time";

describe("aging a recording forward", () => {
  it("keeps a recorded future time in the future however old the recording is", () => {
    const recordedAt = Date.parse("2026-08-23T15:28:19Z");
    const runAt = "2026-08-23T23:38:19+08:00"; // ten minutes after recordedAt
    const aYearLater = Date.parse("2027-08-23T15:28:19Z");

    const shifted = shiftIsoTimestamp(runAt, aYearLater - recordedAt);

    expect(Date.parse(shifted)).toBeGreaterThan(aYearLater);
    // and by the same ten minutes the model actually asked for
    expect(Date.parse(shifted) - aYearLater).toBe(10 * 60_000);
  });

  it("preserves the offset the timestamp was written in", () => {
    expect(shiftIsoTimestamp("2026-08-24T14:00:00+08:00", 0)).toBe("2026-08-24T14:00:00+08:00");
    expect(shiftIsoTimestamp("2026-08-24T06:00:00Z", 0)).toBe("2026-08-24T06:00:00Z");
  });

  it("leaves values that are not timestamps alone", () => {
    const args = {
      name: "Weekly operations report",
      cronExpression: "0 9 * * 1",
      runAt: "2026-08-24T14:00:00+08:00",
      taskTemplate: { title: "Report", priority: 1 },
    };
    const shifted = shiftTimestampsDeep(args, 60_000);
    expect(shifted.name).toBe("Weekly operations report");
    expect(shifted.cronExpression).toBe("0 9 * * 1");
    expect(shifted.taskTemplate).toEqual({ title: "Report", priority: 1 });
    expect(shifted.runAt).toBe("2026-08-24T14:01:00+08:00");
  });
});
