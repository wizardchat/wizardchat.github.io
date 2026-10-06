import { z } from 'zod';
import { attachmentUrlAllowed } from '../config.js';
import { decryptMessage, encryptMessage } from './messageCrypto.js';

export type AttachmentResourceType = 'image' | 'video' | 'raw';

export interface AttachmentDescriptor {
  resourceType: AttachmentResourceType;
  url: string;
  publicId: string | null;
  name: string | null;
  mime: string | null;
  size: number;
  width: number | null;
  height: number | null;
}

export const attachmentSchema = z.object({
  resourceType: z.enum(['image', 'video', 'raw']),
  url: z.string().min(1).max(1024),
  publicId: z.string().max(255).nullable().optional().default(null),
  name: z.string().max(255).nullable().optional().default(null),
  mime: z.string().max(120).nullable().optional().default(null),
  size: z.number().int().min(0).max(2_000_000_000),
  width: z.number().int().min(1).max(20000).nullable().optional().default(null),
  height: z.number().int().min(1).max(20000).nullable().optional().default(null),
});

export type ValidatedAttachment = z.infer<typeof attachmentSchema>;

export function isAttachmentUrlAllowed(url: string): boolean {
  return attachmentUrlAllowed(url);
}

/** Encrypt the attachment descriptor at rest (server AES-256-GCM). */
export function encryptAttachment(
  descriptor: AttachmentDescriptor,
): { ciphertext: string; nonce: string } {
  return encryptMessage(JSON.stringify(descriptor));
}

/** Decrypt and validate a stored attachment descriptor; null when absent/corrupt. */
export function decryptAttachment(payload: {
  ciphertext: string | null;
  nonce: string | null;
}): AttachmentDescriptor | null {
  if (!payload.ciphertext || !payload.nonce) return null;
  try {
    const parsed: unknown = JSON.parse(
      decryptMessage({ ciphertext: payload.ciphertext, nonce: payload.nonce }),
    );
    const result = attachmentSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export interface AttachmentPreview {
  kind: 'image' | 'video' | 'file';
  name: string;
}

/** Small descriptor used in chat-list previews instead of the full attachment. */
export function attachmentPreview(attachment: AttachmentDescriptor): AttachmentPreview {
  return {
    kind: attachment.resourceType === 'raw' ? 'file' : attachment.resourceType,
    name: attachment.name ?? attachment.publicId ?? 'attachment',
  };
}