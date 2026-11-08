import { SESSION_COOKIE } from "@realentity/storm-shared";
import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC, type AuthenticatedRequest } from "./public.decorator";
import { SessionService } from "./session.service";

/** Global guard: every route needs a valid session cookie unless it is @Public(). */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const cookies = request.cookies as Record<string, string | undefined> | undefined;
    const token = cookies?.[SESSION_COOKIE];
    const user = token ? await this.sessions.resolve(token) : null;
    if (!user) {
      throw new UnauthorizedException();
    }
    request.user = user;
    return true;
  }
}
