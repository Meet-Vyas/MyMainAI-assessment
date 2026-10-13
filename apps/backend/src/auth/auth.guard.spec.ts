import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { AdminGuard } from './auth.guard';
import { SESSION_COOKIE, type AuthService } from './auth.service';

function contextWithCookies(cookies: Record<string, string> | undefined) {
  const req: Record<string, unknown> = { cookies };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  return { ctx, req };
}

describe('AdminGuard', () => {
  const user = { id: 'u1', email: 'admin@ugn.local' };
  const auth = { verify: jest.fn(async (t?: string) => (t === 'good' ? user : null)) } as unknown as AuthService;
  const guard = new AdminGuard(auth);

  it('attaches the user for a valid session cookie', async () => {
    const { ctx, req } = contextWithCookies({ [SESSION_COOKIE]: 'good' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toEqual(user);
  });

  it('rejects a missing or invalid cookie with 401', async () => {
    await expect(guard.canActivate(contextWithCookies(undefined).ctx)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(contextWithCookies({ [SESSION_COOKIE]: 'bad' }).ctx)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
