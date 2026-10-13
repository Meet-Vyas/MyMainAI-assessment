import { PartUploadError, type PutPart } from './UploadEngine';

/**
 * If no bytes move for this long, treat the connection as dead. A dropped Wi-Fi link often hangs
 * the socket instead of erroring, so without this a part could wait forever.
 */
const STALL_TIMEOUT_MS = 45_000;

/** PUTs a part with XMLHttpRequest, because fetch() can't report upload progress. */
export const xhrPutPart: PutPart = (url, body, onProgress, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const xhr = new XMLHttpRequest();
    let stallTimer: ReturnType<typeof setTimeout>;
    const resetStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => xhr.abort(), STALL_TIMEOUT_MS);
    };
    const finish = (fn: () => void) => {
      clearTimeout(stallTimer);
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => xhr.abort();

    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => {
      resetStall();
      onProgress(e.loaded);
    };
    xhr.onload = () =>
      finish(() => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new PartUploadError(xhr.status))));
    xhr.onerror = () => finish(() => reject(new PartUploadError(0)));
    // Fired by our own pause/cancel (signal) or by the stall timer; the engine tells them apart.
    xhr.onabort = () =>
      finish(() => reject(signal.aborted ? new DOMException('Aborted', 'AbortError') : new PartUploadError(0)));

    signal.addEventListener('abort', onAbort, { once: true });
    resetStall();
    xhr.send(body);
  });
