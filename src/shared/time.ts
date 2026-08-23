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

