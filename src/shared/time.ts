/**
 * The current time as a local ISO string carrying its own offset.
 *
 * Handing the model a UTC instant alongside a separate zone name invites it to
 * take the UTC wall clock and stamp the user's offset onto it, which lands
 * hours away from the intended moment -- in the past for positive offsets, and
 * silently in the future for negative ones. One self-consistent timestamp
 * removes the ambiguity.
 */
export function isoWithLocalOffset(date: Date = new Date()): string {
  const pad = (value: number) => String(Math.abs(Math.trunc(value))).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const offset = `${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`
  );
}


const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Shifts an ISO timestamp by `shiftMs`, keeping the offset it was written in.
 *
 * A recorded model turn freezes absolute times, but what the model expressed
 * was relative -- "in 10 minutes" became a specific instant. Replaying that
 * instant later puts it in the past and fails validation that had passed when
 * it was recorded, so the recording would rot on the clock rather than on any
 * change to the code. Shifting by the age of the recording restores the
 * distance the model intended.
 */
export function shiftIsoTimestamp(value: string, shiftMs: number): string {
  if (!isoTimestampPattern.test(value)) return value;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  const zone = /(?:Z|[+-]\d{2}:?\d{2})$/.exec(value)?.[0] ?? "Z";
  const offsetMinutes =
    zone === "Z"
      ? 0
      : (zone.startsWith("-") ? -1 : 1) *
        (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2)));
  const shifted = new Date(parsed + shiftMs + offsetMinutes * 60_000);
  const pad = (input: number) => String(input).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    (zone === "Z" ? "Z" : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone)
  );
}

/** Applies {@link shiftIsoTimestamp} to every timestamp nested in a value. */
export function shiftTimestampsDeep<T>(value: T, shiftMs: number): T {
  if (typeof value === "string") return shiftIsoTimestamp(value, shiftMs) as T;
  if (Array.isArray(value)) {
    return value.map((item) => shiftTimestampsDeep(item, shiftMs)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shiftTimestampsDeep(item, shiftMs)]),
    ) as T;
  }
  return value;
}
