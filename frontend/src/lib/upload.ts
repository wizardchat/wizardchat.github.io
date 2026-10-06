import { ApiError, getUploadSignature } from './chatApi';
import type { Attachment, AttachmentKind } from './types';

/** Give large uploads room to breathe; anything longer is a stuck connection. */
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;

function resourceTypeFor(file: File): AttachmentKind {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return 'raw';
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
    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded, event.total);
      };
    }
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => reject(new Error('Upload failed — check your connection and try again.'));
    xhr.ontimeout = () => reject(new Error('Upload timed out — check your connection and try again.'));
    xhr.onabort = () => reject(new Error('Upload cancelled.'));
    xhr.send(form);
  });
}

/**
 * Requests a one-time signed upload URL from the API and uploads the file
 * directly to Cloudinary. The API secret never touches this client.
 */
export async function uploadAttachment(
  file: File,
  onProgress?: (uploadedBytes: number, totalBytes: number) => void,
): Promise<Attachment> {
  const resourceType = resourceTypeFor(file);
  let signature: Awaited<ReturnType<typeof getUploadSignature>>;
  try {
    signature = await getUploadSignature(resourceType);
  } catch (err) {
    throw new Error(signatureError(err), { cause: err });
  }

  const form = new FormData();
  form.append('file', file);
  form.append('api_key', signature.apiKey);
  form.append('timestamp', String(signature.timestamp));
  form.append('folder', signature.folder);
  form.append('signature', signature.signature);

  let result: { status: number; body: string };
  try {
    result = await uploadRaw(
      `https://api.cloudinary.com/v1_1/${signature.cloudName}/${resourceType}/upload`,
      form,
      onProgress,
    );
  } catch (err) {
    throw err instanceof Error ? err : new Error('Upload failed — check your connection and try again.');
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
    resourceType,
    url: data.secure_url ?? data.url ?? '',
    publicId: data.public_id ?? null,
    name: file.name,
    mime: file.type || null,
    size: file.size,
    width: data.width ?? null,
    height: data.height ?? null,
  };
}