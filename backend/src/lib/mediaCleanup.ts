import { cloudinaryConfig } from '../config.js';
import type { AttachmentDescriptor, AttachmentPartDescriptor } from './attachments.js';

interface DestroyCandidate {
  publicId: string | null;
  resourceType: 'image' | 'video' | 'raw';
}

/**
 * Best-effort deletion of Cloudinary assets referenced by an attachment
 * descriptor: the main asset plus any split `.part` fragments (always raw).
 * Failures are logged and swallowed — message deletion must never be held
 * hostage by media cleanup.
 */
export function attachmentDestroyCandidates(attachment: AttachmentDescriptor): DestroyCandidate[] {
  const candidates: DestroyCandidate[] = [];
  if (attachment.publicId) {
    candidates.push({ publicId: attachment.publicId, resourceType: attachment.resourceType });
  }
  for (const part of attachment.parts ?? []) {
    candidates.push({ publicId: part.publicId, resourceType: 'raw' });
  }
  return candidates;
}

export async function destroyCloudinaryAssets(candidates: DestroyCandidate[]): Promise<void> {
  if (!cloudinaryConfig) return;
  const { cloudName, apiKey, apiSecret } = cloudinaryConfig;
  const auth = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;

  // Group by resource type for one call each.
  const byType = new Map<'image' | 'video' | 'raw', string[]>();
  for (const candidate of candidates) {
    if (!candidate.publicId) continue;
    const list = byType.get(candidate.resourceType) ?? [];
    list.push(candidate.publicId);
    byType.set(candidate.resourceType, list);
  }

  await Promise.all(
    [...byType.entries()].map(async ([resourceType, publicIds]) => {
      try {
        const body = new URLSearchParams();
        for (const publicId of publicIds) body.append('public_ids[]', publicId);
        body.append('type', 'upload');
        const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/resources/${resourceType}/destroy`, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: String(body),
        });
        if (!res.ok) {
          console.warn(`[media] destroy ${resourceType} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
        }
      } catch (err) {
        console.warn(`[media] destroy ${resourceType} error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}

export type { DestroyCandidate, AttachmentPartDescriptor };