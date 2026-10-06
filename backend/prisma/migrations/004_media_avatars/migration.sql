-- Media attachments + avatars
-- Message.attachmentCiphertext/Nonce: attachment descriptor (JSON) encrypted at
-- rest with the server key (AES-256-GCM), matching message content at rest.
ALTER TABLE "Message" ADD COLUMN "attachmentCiphertext" TEXT;
ALTER TABLE "Message" ADD COLUMN "attachmentNonce" TEXT;

ALTER TABLE "User" ADD COLUMN "avatarUrl" TEXT;