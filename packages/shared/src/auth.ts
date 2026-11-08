import { z } from "zod";

export const LoginSchema = z.object({
  password: z.string().min(1).max(1024),
  totp: z.string().regex(/^\d{6}$/, "6 digits"),
});
export type LoginRequest = z.infer<typeof LoginSchema>;

export interface SessionView {
  userId: string;
  email: string;
  expiresAt: string;
}

export const SESSION_COOKIE = "storm_session";
