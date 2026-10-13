import { z } from 'zod';

export const LoginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export interface AuthUser {
  id: string;
  email: string;
}
