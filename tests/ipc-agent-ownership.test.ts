// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { EventType } from '@ag-ui/core';
import { IpcCoworkerAgent } from '@renderer/copilot/IpcCoworkerAgent';
import type { DesktopEvent } from '@shared/contracts';
it('deduplicates observed events but accepts an approval continuation with the same run id', () => {
  let listener: (event: DesktopEvent) => void = () => undefined;
  const unsubscribe = vi.fn();
  Object.defineProperty(window,'coworker',{configurable:true,value:{events:{subscribe: (fn: typeof listener) => {listener=fn; return unsubscribe;}}, agents:{run:vi.fn().mockResolvedValue({})}}});
  const agent = new IpcCoworkerAgent('a');
  const seen: unknown[] = [];
  agent.run({runId:'run',threadId:'thread',messages:[],tools:[],context:[],state:{},forwardedProps:{}}).subscribe(event => seen.push(event));
  expect(agent.ownsRun('run')).toBe(true);
  listener({type:'agent.event',coworkerId:'a',conversationId:'thread',taskId:'task',runId:'run',sequence:4,event:{type:EventType.RUN_FINISHED}});
  expect(agent.isStreaming).toBe(false);
  expect(agent.ownsRun('run',4)).toBe(true);
  expect(agent.ownsRun('run',5)).toBe(false);
  expect(agent.ownsRun('another',2)).toBe(false);
  expect(seen).toHaveLength(1);
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(agent.clone()).toBe(agent);
});
