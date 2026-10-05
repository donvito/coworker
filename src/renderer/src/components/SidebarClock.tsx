import { useEffect, useState } from "react";
import { formatClockTime } from "@shared/time";

export function SidebarClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const update = () => setNow(new Date());
    const timer = window.setInterval(update, 1000);
    window.addEventListener("focus", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, []);
  const date = now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return (
    <section aria-label="Current time" className="team-clock conversation-sidebar-clock">
      <time dateTime={now.toISOString()}>
        <strong>{formatClockTime(now)}</strong>
        <span>{date}</span>
      </time>
    </section>
  );
}
