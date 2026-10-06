import { ApiError, getUploadSignature } from './chatApi';
import type { Attachment, AttachmentKind } from './types';

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

/**
 * Requests a one-time signed upload URL from the API and uploads the file
 * directly to Cloudinary. The API secret never touches this client.
 */
export async function uploadAttachment(file: File): Promise<Attachment> {
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

  let res: Response;
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${signature.cloudName}/${resourceType}/upload`, {
      method: 'POST',
      body: form,
    });
  } catch {
    throw new Error('Upload failed — check your connection');
  }

  if (!res.ok) {
    let message = `Upload failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { message?: string } | string };
      if (typeof body.error === 'string') message = body.error;
      else if (body.error?.message) message = body.error.message;
    } catch {
      /* keep default message */
    }
    throw new Error(message);
  }

  const data = (await res.json()) as {
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