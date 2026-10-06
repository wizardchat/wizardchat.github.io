-- E2EE identity: public key + password-wrapped private key (client-generated)
ALTER TABLE "User" ADD COLUMN "e2ePublicKey" TEXT;
ALTER TABLE "User" ADD COLUMN "e2eWrappedKey" TEXT;
ALTER TABLE "User" ADD COLUMN "e2eKekSalt" TEXT;
ALTER TABLE "User" ADD COLUMN "e2eKekParams" TEXT;
ALTER TABLE "User" ADD COLUMN "e2eKeysUpdatedAt" TIMESTAMP(3);
