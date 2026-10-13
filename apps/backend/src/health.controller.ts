import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@ugn/contracts';

@Controller('health')
export class HealthController {
  @Get()
  get(): HealthResponse {
    return { status: 'ok', service: 'backend' };
  }
}
