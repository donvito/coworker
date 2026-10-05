import { expect, it } from 'vitest';
import { EventType } from '@ag-ui/core';
import { RunEventJournal, type RunEvent } from '@shared/run-event-journal';
const event = (runId: string, type: EventType, extra = {}): RunEvent => ({type:'agent.event', coworkerId:'a', conversationId:'c', runId, taskId:runId, event:{type,...extra}});
it('preserves partial text and tool events across view subscriptions and ignores duplicate snapshots', () => {
  const journal = new RunEventJournal();
  journal.append(event('r',EventType.RUN_STARTED));
  journal.append(event('r',EventType.TEXT_MESSAGE_START,{messageId:'m'}));
  journal.append(event('r',EventType.TEXT_MESSAGE_CONTENT,{messageId:'m',delta:'Hello '}));
  const latest = journal.append(event('r',EventType.TEXT_MESSAGE_CONTENT,{messageId:'m',delta:'world'}));
  journal.append(latest);
  journal.append(event('r',EventType.TOOL_CALL_START,{toolCallId:'t',toolCallName:'files.list'}));
  const snapshot = journal.snapshot();
  expect(snapshot.filter(e => e.event.type === EventType.TEXT_MESSAGE_CONTENT).map(e => e.event['delta']).join('')).toBe('Hello world');
  expect(snapshot.at(-1)?.event.type).toBe(EventType.TOOL_CALL_START);
  expect(snapshot.map(e => e.sequence)).toEqual([1,2,4,5]);
});
it('retains active runs while evicting old completed runs', () => {
  const journal = new RunEventJournal();
  journal.append(event('active',EventType.RUN_STARTED));
  for(let i=0;i<60;i++) journal.append(event(String(i),EventType.RUN_FINISHED));
  expect(new Set(journal.snapshot().map(e => e.runId)).size).toBe(51);
  expect(journal.snapshot()[0]?.runId).toBe('active');
});
