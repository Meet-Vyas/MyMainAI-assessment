import { PrismaClient } from '@ugn/db';
import { hashPassword } from './auth/password';

/**
 * Idempotent: creates the single admin, or resets its password to ADMIN_PASSWORD.
 * Runs on every container start, so changing the env var is how you change the password.
 */
async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set');
  if (password.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters');

  const prisma = new PrismaClient();
  try {
    const passwordHash = await hashPassword(password);
    await prisma.user.upsert({ where: { email }, create: { email, passwordHash }, update: { passwordHash } });
    console.log(`seeded admin ${email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
