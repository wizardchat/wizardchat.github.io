import { ApiError, getUploadSignature } from './chatApi';
import type { Attachment, AttachmentKind } from './types';

/** Give large uploads room to breathe; anything longer is a stuck connection. */
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Cloudinary's per-type upload caps for the current account plan (free:
 * 10 MB images/raw, 100 MB video). Files that exceed their type's cap are
 * automatically split into `.part` fragments (raw is the only fully reliable
 * resource type for arbitrary bytes) and reassembled on the recipient's side.
 * Bump these if the Cloudinary plan is upgraded.
 */
const MAX_BYTES_BY_TYPE: Record<AttachmentKind, number> = {
  image: 10 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  raw: 10 * 1024 * 1024,
};

/** Fragments are uploaded as raw, so the raw cap is the split chunk size. */
const PART_SIZE = MAX_BYTES_BY_TYPE.raw;
const MAX_PARTS = 100;

function resourceTypeFor(file: File): AttachmentKind {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return 'raw';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function signatureError(err: unknown): string {
  if (err instanceof ApiError && err.status === 503) {
    return 'File uploads are not configured on this server';
  }
  return 'Could not request upload access';
}

/** Raw XHR POST so we can report real progress and distinguish timeouts. */
function uploadRaw(
  url: string,
  form: FormData,
  onProgress?: (uploadedBytes: number, totalBytes: number) => void,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.responseType = 'text';
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    let fullySent = false;
    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          if (event.loaded >= event.total) fullySent = true;
          onProgress(event.loaded, event.total);
        }
      };
    }
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    const fail = (message: string) => {
      const err = new Error(message) as Error & { fullySent?: boolean };
      err.fullySent = fullySent;
      reject(err);
    };
    xhr.onerror = () => fail('Upload failed — check your connection and try again.');
    xhr.ontimeout = () => fail('Upload timed out — check your connection and try again.');
    xhr.onabort = () => reject(new Error('Upload cancelled.'));
    xhr.send(form);
  });
}

interface CloudinaryResult {
  url: string;
  publicId: string | null;
  width: number | null;
  height: number | null;
}

/**
 * Requests a one-time signed upload URL and uploads a blob directly to
 * Cloudinary. Per-part retry when the file was fully sent but the confirmation
 * response was lost (worst case: an orphaned asset, never a wrong message).
 */
async function uploadOne(
  resourceType: AttachmentKind,
  blob: Blob,
  filename: string,
  onProgress?: (uploadedBytes: number, totalBytes: number) => void,
): Promise<CloudinaryResult> {
  let signature: Awaited<ReturnType<typeof getUploadSignature>>;
  try {
    signature = await getUploadSignature(resourceType);
  } catch (err) {
    throw new Error(signatureError(err), { cause: err });
  }

  const form = new FormData();
  form.append('file', blob, filename);
  form.append('api_key', signature.apiKey);
  form.append('timestamp', String(signature.timestamp));
  form.append('folder', signature.folder);
  form.append('signature', signature.signature);

  let result: { status: number; body: string };
  let attempt = 1;
  for (;;) {
    try {
      result = await uploadRaw(
        `https://api.cloudinary.com/v1_1/${signature.cloudName}/${resourceType}/upload`,
        form,
        onProgress,
      );
      break;
    } catch (err) {
      const failed = err as Error & { fullySent?: boolean };
      if (attempt === 1 && failed.fullySent) {
        attempt += 1;
        continue;
      }
      throw err instanceof Error
        ? err
        : new Error('Upload failed — check your connection and try again.');
    }
  }

  if (result.status !== 200) {
    let message = `Upload failed (${result.status})`;
    try {
      const body = JSON.parse(result.body) as { error?: { message?: string } | string };
      if (typeof body.error === 'string') message = body.error;
      else if (body.error?.message) message = body.error.message;
    } catch {
      /* keep default message */
    }
    throw new Error(message);
  }

  const data = JSON.parse(result.body) as {
    secure_url?: string;
    url?: string;
    public_id?: string;
    width?: number;
    height?: number;
  };

  return {
    url: data.secure_url ?? data.url ?? '',
    publicId: data.public_id ?? null,
    width: data.width ?? null,
    height: data.height ?? null,
  };
}

function splitIntoParts(file: File, partSize: number): Blob[] {
  const parts: Blob[] = [];
  for (let start = 0; start < file.size; start += partSize) {
    parts.push(file.slice(start, Math.min(start + partSize, file.size), file.type));
  }
  return parts;
}

/**
 * Requests a one-time signed upload URL from the API and uploads the file
 * directly to Cloudinary. The API secret never touches this client. Files
 * larger than their type's cap are split into `.part` fragments.
 */
export async function uploadAttachment(
  file: File,
  onProgress?: (uploadedBytes: number, totalBytes: number) => void,
): Promise<Attachment> {
  const resourceType = resourceTypeFor(file);
  const cap = MAX_BYTES_BY_TYPE[resourceType];

  if (file.size <= cap) {
    const uploaded = await uploadOne(resourceType, file, file.name, onProgress);
    return {
      resourceType,
      url: uploaded.url,
      publicId: uploaded.publicId,
      name: file.name,
      mime: file.type || null,
      size: file.size,
      width: uploaded.width,
      height: uploaded.height,
    };
  }

  const chunkBlobs = splitIntoParts(file, PART_SIZE);
  if (chunkBlobs.length > MAX_PARTS) {
    throw new Error(
      `${file.name} is ${formatBytes(file.size)} — that would need ${chunkBlobs.length} parts (max ${MAX_PARTS}, ~${formatBytes(PART_SIZE * MAX_PARTS)}). Try compressing it or sending a smaller file.`,
    );
  }

  const digitWidth = String(chunkBlobs.length).length;
  const parts: Attachment['parts'] = [];
  let completedBytes = 0;
  for (let i = 0; i < chunkBlobs.length; i++) {
    const chunk = chunkBlobs[i];
    if (!chunk) throw new Error('Upload failed — could not read file part.');
    const partSize = chunk.size;
    const uploaded = await uploadOne(
      'raw',
      chunk,
      `part-${String(i + 1).padStart(digitWidth, '0')}.part`,
      (loaded, total) => {
        if (!onProgress) return;
        onProgress(Math.min(completedBytes + Math.min(loaded, total), file.size), file.size);
      },
    );
    parts.push({ url: uploaded.url, publicId: uploaded.publicId, size: partSize });
    completedBytes += partSize;
  }

  const firstUrl = parts[0]?.url ?? '';
  return {
    resourceType: 'raw',
    url: firstUrl,
    publicId: null,
    name: file.name,
    mime: file.type || null,
    size: file.size,
    width: null,
    height: null,
    parts,
  };
}