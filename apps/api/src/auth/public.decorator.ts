import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";
import { type Request } from "express";

export const IS_PUBLIC = "isPublic";

/** Marks a route as reachable without a session (health, login). Everything else requires one. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

export interface AuthenticatedUser {
  userId: string;
  email: string;
  userSessionId: string;
  expiresAt: Date;
}

export type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

/** The signed-in user, set by SessionGuard. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthenticatedUser => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.user) {
    throw new Error("CurrentUser used on a public route");
  }
  return request.user;
});
