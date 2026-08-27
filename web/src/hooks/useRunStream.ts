import {useEffect, useState} from 'react';
import {RunManifest} from '../types';

export const useRunStream = (runId: string | null, initial?: RunManifest) => {
  const [run, setRun] = useState<RunManifest | undefined>(initial);

  useEffect(() => setRun(initial), [initial]);
  useEffect(() => {
    if (!runId) return;
    const stream = new EventSource(`/api/runs/${runId}/events`);
    stream.onmessage = (event) => setRun(JSON.parse(event.data) as RunManifest);
    return () => stream.close();
  }, [runId]);
  return [run, setRun] as const;
};
