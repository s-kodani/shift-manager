// Private diagnostics describe a response signature, never its contents or cause.
export type ProbeHttpDiagnostic = {
  status: number;
  bodyState: 'COMPLETE' | 'EMPTY' | 'OVER_LIMIT' | 'READ_FAILED' | 'TIMED_OUT';
  signature: 'MODEL_ERROR_JSON' | 'VALIDATION_ERROR_JSON' | 'BODY_LIMIT_JSON' |
    'NOT_FOUND_JSON' | 'SDK_START_PREFIX' | 'SDK_CAPACITY_PREFIX' | 'UNRECOGNIZED';
};
export class ProbeHttpFailure extends Error {
  constructor(readonly http: ProbeHttpDiagnostic) {
    super(`PROBE_HTTP_${http.status}`);
  }
}

function signature(bytes: Uint8Array, status: number): ProbeHttpDiagnostic['signature'] {
  let body: string;
  try { body = new TextDecoder('utf-8', {fatal: true, ignoreBOM: false}).decode(bytes); }
  catch { return 'UNRECOGNIZED'; }
  // Exact prefixes from installed @cloudflare/containers 0.3.7. Never return suffixes.
  if (status === 500 && body.startsWith('Failed to start container: ')) return 'SDK_START_PREFIX';
  if (status === 503 && body.startsWith('There is no Container instance available at this time.\n')) return 'SDK_CAPACITY_PREFIX';
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== 1 || !Object.hasOwn(value, 'error')) return 'UNRECOGNIZED';
    const code = (value as {error: unknown}).error;
    if (status === 500 && code === 'MODEL_ERROR') return 'MODEL_ERROR_JSON';
    if (status === 400 && typeof code === 'string' && ['ValidationError', 'ValueError', 'KeyError', 'TypeError', 'BODY_LENGTH'].includes(code)) return 'VALIDATION_ERROR_JSON';
    if (status === 413 && code === 'BODY_LIMIT') return 'BODY_LIMIT_JSON';
    if (status === 404 && code === 'NOT_FOUND') return 'NOT_FOUND_JSON';
  } catch { /* Malformed/unknown bodies retain only a fixed signature. */ }
  return 'UNRECOGNIZED';
}

export async function probeHttpFailure(response: Response, deadline = Date.now() + 2_000): Promise<ProbeHttpFailure> {
  const diagnostic: ProbeHttpDiagnostic = {status: response.status, bodyState: 'EMPTY', signature: 'UNRECOGNIZED'};
  if (!response.body) return new ProbeHttpFailure(diagnostic);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = response.body.getReader(); }
  catch { return new ProbeHttpFailure({...diagnostic, bodyState: 'READ_FAILED'}); }
  const timedOut = Symbol('diagnostic-timeout');
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<typeof timedOut>(resolve => {
    timer = setTimeout(() => resolve(timedOut), Math.max(1, Math.min(2_000, deadline - Date.now())));
  });
  const chunks: Uint8Array[] = [];
  let size = 0, reads = 0, complete = false;
  try {
    while (true) {
      // Bound even a controlled/malformed stream that produces endless empty
      // chunks without yielding to the clock. 4 KiB byte-by-byte plus EOF fits.
      if (++reads > 4_097) { diagnostic.bodyState = 'OVER_LIMIT'; break; }
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk === timedOut) { diagnostic.bodyState = 'TIMED_OUT'; break; }
      if (chunk.done) { complete = true; break; }
      size += chunk.value.byteLength;
      if (size > 4_096) { diagnostic.bodyState = 'OVER_LIMIT'; break; }
      if (chunk.value.byteLength) chunks.push(chunk.value);
    }
    if (complete && size) {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      diagnostic.bodyState = 'COMPLETE';
      diagnostic.signature = signature(bytes, response.status);
    }
  } catch { diagnostic.bodyState = 'READ_FAILED'; }
  finally {
    // Cancellation failure/never-settling cancellation must not hide the HTTP
    // status or delay the owned process stop beyond this bounded read deadline.
    if (!complete) {
      try { await Promise.race([reader.cancel().catch(() => {}), timeout]); }
      catch { /* Preserve the original bounded diagnostic. */ }
    }
    clearTimeout(timer!);
    try { reader.releaseLock(); } catch { /* No body details escape cleanup. */ }
  }
  return new ProbeHttpFailure(diagnostic);
}
