/** Typed in-process event bus. Controllers emit, the Claim Agent listens. */
import { EventEmitter } from 'events';

export interface AgentEvents {
  'policy.uploaded': { policyId: string; userId: string };
  'claim.created': { claimId: string };
  'document.uploaded': { claimId: string; documentId: string };
  'documents.complete': { claimId: string };
  'document.missing': { claimId: string; missing: string[] };
  'query.answered': { claimId: string; queryId: string; documentId?: string };
  'claim.ready': { claimId: string };
}
export type AgentEventName = keyof AgentEvents;

class Bus extends EventEmitter {
  emitEvent<K extends AgentEventName>(name: K, payload: AgentEvents[K]) {
    console.log(`[bus] ${name}`, JSON.stringify(payload));
    return super.emit(name, payload);
  }
  onEvent<K extends AgentEventName>(name: K, fn: (p: AgentEvents[K]) => Promise<void> | void) {
    return super.on(name, (p: AgentEvents[K]) => {
      Promise.resolve(fn(p)).catch((e) => console.error(`[agent] ${name} handler failed:`, e));
    });
  }
}
export const bus = new Bus();
bus.setMaxListeners(50);
