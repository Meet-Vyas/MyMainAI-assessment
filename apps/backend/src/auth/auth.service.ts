import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { AuthUser, LoginRequest } from '@ugn/contracts';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password';

export const SESSION_COOKIE = 'ugn_session';
const ISSUER = 'ugn-backend';
const AUDIENCE = 'ugn-admin';

@Injectable()
export class AuthService {
  private readonly secret: Uint8Array;
  // Hash of a random password, compared against when the email is unknown, so a miss takes
  // as long as a wrong password and response timing doesn't reveal which emails exist.
  private readonly dummyHash = hashPassword(randomUUID());

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.secret = new TextEncoder().encode(config.JWT_SECRET);
  }

  get sessionTtlSeconds(): number {
    return this.config.JWT_TTL_SECONDS;
  }

  async login({ email, password }: LoginRequest): Promise<{ user: AuthUser; token: string }> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    const ok = await verifyPassword(password, user?.passwordHash ?? (await this.dummyHash));
    if (!user || !ok) throw new UnauthorizedException('Invalid email or password');

    const authUser = { id: user.id, email: user.email };
    return { user: authUser, token: await this.sign(authUser) };
  }

  sign(user: AuthUser): Promise<string> {
    return new SignJWT({ email: user.email })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.config.JWT_TTL_SECONDS}s`)
      .sign(this.secret);
  }

  /** Returns the user for a valid token, or null for a missing, expired, tampered or foreign one. */
  async verify(token: string | undefined): Promise<AuthUser | null> {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null;
      return { id: payload.sub, email: payload.email };
    } catch {
      return null;
    }
  }
}
