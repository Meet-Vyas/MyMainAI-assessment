import { UnauthorizedException } from '@nestjs/common';
import { SignJWT } from 'jose';
import type { AppConfig } from '../config/config';
import type { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { hashPassword } from './password';

const config = { JWT_SECRET: 'x'.repeat(32), JWT_TTL_SECONDS: 3600 } as AppConfig;

async function makeService() {
  const admin = { id: 'u1', email: 'admin@ugn.local', passwordHash: await hashPassword('admin12345') };
  const prisma = {
    user: { findUnique: jest.fn(async ({ where }) => (where.email === admin.email ? admin : null)) },
  } as unknown as PrismaService;
  return new AuthService(prisma, config);
}

describe('AuthService', () => {
  it('logs in with valid credentials and issues a token that verifies', async () => {
    const auth = await makeService();
    const { user, token } = await auth.login({ email: 'admin@ugn.local', password: 'admin12345' });
    expect(user).toEqual({ id: 'u1', email: 'admin@ugn.local' });
    await expect(auth.verify(token)).resolves.toEqual(user);
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const auth = await makeService();
    const wrongPassword = auth.login({ email: 'admin@ugn.local', password: 'nope' });
    const unknownEmail = auth.login({ email: 'who@ugn.local', password: 'nope' });
    await expect(wrongPassword).rejects.toThrow(new UnauthorizedException('Invalid email or password'));
    await expect(unknownEmail).rejects.toThrow(new UnauthorizedException('Invalid email or password'));
  });

  it('rejects missing, tampered, expired and foreign tokens', async () => {
    const auth = await makeService();
    const token = await auth.sign({ id: 'u1', email: 'admin@ugn.local' });
    const [header, payload, signature] = token.split('.');
    const tampered = [header, payload, signature.slice(0, -2) + (signature.endsWith('AA') ? 'BB' : 'AA')].join('.');

    const expired = await new SignJWT({ email: 'admin@ugn.local' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setIssuer('ugn-backend')
      .setAudience('ugn-admin')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(config.JWT_SECRET));

    const otherSecret = await new AuthService({} as PrismaService, { ...config, JWT_SECRET: 'y'.repeat(32) }).sign({
      id: 'u1',
      email: 'admin@ugn.local',
    });

    await expect(auth.verify(undefined)).resolves.toBeNull();
    await expect(auth.verify('not-a-jwt')).resolves.toBeNull();
    await expect(auth.verify(tampered)).resolves.toBeNull();
    await expect(auth.verify(expired)).resolves.toBeNull();
    await expect(auth.verify(otherSecret)).resolves.toBeNull();
  });
});
