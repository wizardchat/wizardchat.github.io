import type { Attachment } from './types';

/**
 * Downloads a file that was sent as fragments, verifies each part's byte
 * count, concatenates them in order, and triggers a browser download of the
 * original file. Returns when the download has started.
 */
export async function reassembleAttachment(
  attachment: Attachment,
  onProgress?: (receivedBytes: number, totalBytes: number) => void,
): Promise<void> {
  const parts = attachment.parts;
  if (!parts || parts.length < 2) {
    throw new Error('This file was not sent in parts.');
  }

  const buffers: ArrayBuffer[] = [];
  let received = 0;
  for (const [index, partEntry] of parts.entries()) {
    const part = partEntry;
    if (!part) throw new Error(`Part ${index + 1} is missing.`);
    let res: Response;
    try {
      res = await fetch(part.url);
    } catch {
      throw new Error(`Could not download part ${index + 1} — check your connection and try again.`);
    }
    if (!res.ok) {
      throw new Error(`Could not download part ${index + 1} (${res.status}).`);
    }
    const buffer = await res.arrayBuffer();
    if (part.size > 0 && buffer.byteLength !== part.size) {
      throw new Error(`Part ${index + 1} is incomplete (got ${buffer.byteLength} of ${part.size} bytes).`);
    }
    buffers.push(buffer);
    received += buffer.byteLength;
    onProgress?.(received, attachment.size);
  }

  const combined = new Blob(buffers, {
    type: attachment.mime || 'application/octet-stream',
  });
  const objectUrl = URL.createObjectURL(combined);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = attachment.name || 'file';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}