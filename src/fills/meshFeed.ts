// One mesh worker shared by every fill layer (the main globe and the far-side globe), so each
// window is built once and uploaded to each map's GL context.
import type { BuildResult, FocusRequest } from './meshWorker';

export interface MeshFeed {
  /** Windows a client wants, most urgent first. Replaces that client's previous request. */
  request(client: object, windows: number[]): void;
  /** Receives every built window. Returns an unsubscribe function (which also drops its requests). */
  subscribe(client: object, onBuilt: (result: BuildResult) => void): () => void;
}

export function createMeshFeed(): MeshFeed {
  const worker = new Worker(new URL('./meshWorker.ts', import.meta.url), { type: 'module' });
  const requests = new Map<object, number[]>();
  const listeners = new Map<object, (result: BuildResult) => void>();
  let lastSent = '';

  const send = () => {
    // Merge requests in priority order: everyone's most urgent window first.
    const merged: number[] = [];
    const lists = [...requests.values()];
    for (let i = 0; lists.some((l) => i < l.length); i++) {
      for (const l of lists) if (i < l.length && !merged.includes(l[i])) merged.push(l[i]);
    }
    const key = merged.join(',');
    if (key === lastSent) return;
    lastSent = key;
    worker.postMessage({ type: 'focus', windows: merged } satisfies FocusRequest);
  };

  worker.onmessage = (e: MessageEvent<BuildResult>) => {
    lastSent = '';
    for (const onBuilt of listeners.values()) onBuilt(e.data);
  };

  return {
    request(client, windows) {
      requests.set(client, windows);
      send();
    },
    subscribe(client, onBuilt) {
      listeners.set(client, onBuilt);
      return () => {
        listeners.delete(client);
        requests.delete(client);
        send();
      };
    },
  };
}
