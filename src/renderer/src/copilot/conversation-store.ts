import type { AgentConfig } from "@ag-ui/client";
import type { DesktopEvent } from "@shared/contracts";
import { RunEventJournal, type RunEvent } from "@shared/run-event-journal";
import { IpcCoworkerAgent } from "./IpcCoworkerAgent";

const agents = new Map<string, IpcCoworkerAgent>();
export const selectedConversations = new Map<string, string>();
export function conversationAgent(coworkerId: string, config: AgentConfig): IpcCoworkerAgent {
  const key = `${coworkerId}:${config.threadId}`;
  let agent = agents.get(key);
  if (!agent) { agent = new IpcCoworkerAgent(coworkerId, config); agents.set(key, agent); }
  else if (!agent.isStreaming && !agent.isRunning) {
    const known = new Set(agent.messages.map(message => message.id));
    const missing = (config.initialMessages ?? []).filter(message => !known.has(message.id));
    if (missing.length) agent.setMessages([...agent.messages, ...missing]);
  }
  return agent;
}

let started = false;
let ready = false;
const journal = new RunEventJournal();
const listeners = new Set<(event: DesktopEvent) => void>();
export function startConversationEvents(): void {
  if (started) return;
  started = true;
  const pending: RunEvent[] = [];
  window.coworker.events.subscribe(event => {
    if (event.type !== 'agent.event') return;
    if (!ready) { pending.push(event); return; }
    journal.append(event);
    for (const listener of listeners) listener(event);
  });
  void (window.coworker.agents?.snapshot?.() ?? Promise.resolve([])).then(events => {
    const watermark = Math.max(0, ...events.map(event => event.sequence ?? 0));
    for (const event of [...events, ...pending.filter(event => !event.sequence || event.sequence > watermark)].sort((a,b) => (a.sequence ?? 0) - (b.sequence ?? 0))) journal.append(event);
  }).catch(() => { for (const event of pending) journal.append(event); }).finally(() => {
    ready = true;
    for (const event of journal.snapshot()) for (const listener of listeners) listener(event);
  });
}
export function subscribeConversationEvents(listener: (event: DesktopEvent) => void): () => void {
  startConversationEvents();
  listeners.add(listener);
  if (ready) for (const event of journal.snapshot()) listener(event);
  return () => { listeners.delete(listener); };
}
