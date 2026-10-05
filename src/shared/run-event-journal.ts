import { EventType } from "@ag-ui/core";
import type { DesktopEvent } from "./contracts";
export type RunEvent = Extract<DesktopEvent, { type: "agent.event" }>;

/** Compact consecutive deltas, retain complete active runs and recent finished runs. */
export class RunEventJournal {
  private sequence = 0;
  private runs = new Map<string, RunEvent[]>();
  append(input: RunEvent): RunEvent {
    const event = { ...input, sequence: input.sequence ?? ++this.sequence };
    const events = this.runs.get(event.runId) ?? [];
    const previous = events.at(-1);
    if (previous && (previous.sequence ?? 0) >= (event.sequence ?? 0)) return event;
    if (previous?.event.type === EventType.TEXT_MESSAGE_CONTENT && event.event.type === EventType.TEXT_MESSAGE_CONTENT &&
        'messageId' in previous.event && 'messageId' in event.event && previous.event.messageId === event.event.messageId) {
      events[events.length - 1] = { ...event, event: { ...event.event, delta: String(previous.event["delta"]) + String(event.event["delta"]) } } as RunEvent;
    } else events.push(event);
    this.runs.set(event.runId, events);
    const finished = [...this.runs].filter(([, items]) => [EventType.RUN_FINISHED, EventType.RUN_ERROR].includes(items.at(-1)!.event.type as EventType.RUN_FINISHED));
    for (const [id] of finished.slice(0, -50)) this.runs.delete(id);
    return event;
  }
  snapshot(): RunEvent[] { return [...this.runs.values()].flat().sort((a,b) => (a.sequence ?? 0) - (b.sequence ?? 0)); }
}
