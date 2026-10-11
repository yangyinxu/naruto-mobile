import {useEffect, useState} from 'react';
import {RunManifest} from '../types';

export type RunStreamConnection = 'connecting' | 'connected' | 'reconnecting';

export const useRunStream = (runId: string | null, initial?: RunManifest) => {
  const [run, setRun] = useState<RunManifest | undefined>(initial);
  const [connection, setConnection] = useState<RunStreamConnection>('connecting');

  useEffect(() => setRun(initial), [initial]);
  useEffect(() => {
    if (!runId) return;
    setConnection('connecting');
    const stream = new EventSource(`/api/runs/${runId}/events`);
    stream.onopen = () => setConnection('connected');
    stream.onerror = () => setConnection('reconnecting');
    stream.onmessage = (event) => setRun(JSON.parse(event.data) as RunManifest);
    return () => stream.close();
  }, [runId]);
  return [run, setRun, connection] as const;
};
