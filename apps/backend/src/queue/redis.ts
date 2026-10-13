import IORedis, { type RedisOptions } from 'ioredis';

/**
 * Queues (producers) keep ioredis's default retry limit so an add fails fast when Redis is down
 * instead of hanging an HTTP request. BullMQ workers must use maxRetriesPerRequest: null.
 */
export function createRedis(url: string, kind: 'producer' | 'worker'): IORedis {
  const options: RedisOptions = kind === 'worker' ? { maxRetriesPerRequest: null } : {};
  return new IORedis(url, options);
}
