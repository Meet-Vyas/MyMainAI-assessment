import { expectedPartSize, partCount } from '@ugn/contracts';
import type { UploadedPart } from '../storage/storage.service';

/**
 * Compares what S3 actually holds against what the file needs. The server decides completeness
 * from S3's own part list rather than trusting the client's bookkeeping.
 */
export function checkParts(parts: UploadedPart[], fileSize: number, partSize: number) {
  const count = partCount(fileSize, partSize);
  const byNumber = new Map(parts.map((p) => [p.partNumber, p]));
  const missingParts: number[] = [];
  const wrongSizeParts: number[] = [];
  for (let n = 1; n <= count; n++) {
    const part = byNumber.get(n);
    if (!part) missingParts.push(n);
    else if (part.size !== expectedPartSize(n, fileSize, partSize)) wrongSizeParts.push(n);
  }
  // Only parts 1..count go into CompleteMultipartUpload; any stray higher-numbered part is discarded by S3.
  const ordered = Array.from({ length: count }, (_, i) => byNumber.get(i + 1)!);
  return { missingParts, wrongSizeParts, ordered: missingParts.length || wrongSizeParts.length ? [] : ordered };
}
