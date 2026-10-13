import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { CookieOptions, Response } from 'express';
import { LoginRequestSchema, type AuthUser, type LoginRequest } from '@ugn/contracts';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminGuard, type AuthedRequest } from './auth.guard';
import { AuthService, SESSION_COOKIE } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(LoginRequestSchema)) body: LoginRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthUser> {
    const { user, token } = await this.auth.login(body);
    res.cookie(SESSION_COOKIE, token, { ...this.cookieOptions(), maxAge: this.auth.sessionTtlSeconds * 1000 });
    return user;
  }

  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response): void {
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }

  @Get('me')
  @UseGuards(AdminGuard)
  me(@Req() req: AuthedRequest): AuthUser {
    return req.user;
  }

  private cookieOptions(): CookieOptions {
    // Lax blocks the cookie on cross-site POSTs (CSRF) while still sending it on normal navigation.
    return { httpOnly: true, sameSite: 'lax', secure: this.config.COOKIE_SECURE, path: '/' };
  }
}
