import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const runtime = JSON.parse(readFileSync(process.env.BRIDGE_RUNTIME ?? `${import.meta.dir}/runtime.json`, 'utf8'));
async function request(path: string, body?: unknown) {
  const response = await fetch(runtime.url + '/api/' + path, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json() as any;
  if (!response.ok) throw new Error(`${response.status}: ${result.error}`);
  return result;
}
const operationFile = process.argv[2];
if (!operationFile) console.log(JSON.stringify(await request('document'), null, 2));
else {
  const input = JSON.parse(readFileSync(resolve(operationFile), 'utf8'));
  for (let attempt = 0; ; attempt++) {
    const current = await request('document');
    try {
      const job = await request('operations', { ...input, expectedRevision: current.revision });
      const deadline = Date.now() + 35_000;
      while (Date.now() < deadline) {
        await Bun.sleep(200);
        const result = await request('jobs/' + job.id);
        if (result.status === 'completed') { console.log(JSON.stringify(result.result)); process.exit(0); }
        if (result.status === 'failed') throw new Error(result.error);
      }
      throw new Error('Editor did not finish the update');
    } catch (error) {
      if (attempt >= 2 || !/Diagram changed|Cell not found/.test(String(error))) throw error;
      console.error('Diagram changed while preparing update; re-reading and retrying.');
    }
  }
}
