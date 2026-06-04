import { NerdGraphError } from './errors.js';

export async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (isAborted(signal)) throw cancelledResponseRead(signal?.reason);
  const advertisedLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(advertisedLength) && advertisedLength > maximumBytes) {
    await response.body?.cancel();
    throw new NerdGraphError(
      'response-too-large',
      'New Relic response exceeded the configured limit',
      {
        status: response.status,
      },
    );
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let output = '';
  const onAbort = (): void => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let finished = false;
    while (!finished) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (isAborted(signal)) throw cancelledResponseRead(error);
        throw error;
      }
      if (isAborted(signal)) throw cancelledResponseRead(signal?.reason);
      const { done, value } = chunk;
      if (done) {
        finished = true;
        continue;
      }
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new NerdGraphError(
          'response-too-large',
          'New Relic response exceeded the configured limit',
          {
            status: response.status,
          },
        );
      }
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function cancelledResponseRead(cause: unknown): NerdGraphError {
  return new NerdGraphError('cancelled', 'New Relic response read was cancelled', { cause });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
