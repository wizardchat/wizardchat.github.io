import 'dotenv/config';
import { Algorithm, hash } from '@node-rs/argon2';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Must match src/lib/password.ts (OWASP Argon2id parameters).
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const username = (process.env.ADMIN_USERNAME ?? 'admin').trim().toLowerCase();

  if (!password) {
    console.info('[seed] ADMIN_PASSWORD not set — skipping admin seed');
    return;
  }

  if (password.length < 8) {
    console.error('[seed] ADMIN_PASSWORD must be at least 8 characters');
    process.exitCode = 1;
    return;
  }

  const existing = await prisma.user.findFirst({
    where: { OR: [{ username }, ...(email ? [{ email }] : [])] },
  });

  if (existing) {
    if (existing.role !== 'ADMIN') {
      await prisma.user.update({ where: { id: existing.id }, data: { role: 'ADMIN' } });
      console.info(`[seed] Promoted existing user ${existing.username} to ADMIN`);
    } else {
      console.info('[seed] Admin user already exists — no changes');
    }
    return;
  }

  const passwordHash = await hash(password, ARGON2_OPTIONS);
  const user = await prisma.user.create({
    data: { username, ...(email ? { email } : {}), passwordHash, role: 'ADMIN' },
  });
  console.info(
    `[seed] Created admin user ${user.username}${email ? ` (${email})` : ' (no email)'}`,
  );
}

main()
  .catch((err) => {
    console.error('[seed] Failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
