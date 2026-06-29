import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Shape that `JwtStrategy.validate` attaches to `req.user`. */
export interface AuthenticatedUser {
  userId: string;
  role: string;
  email: string;
}

/**
 * Extracts the authenticated principal (`req.user`) populated by `JwtStrategy`.
 * Pass a property name to project a single field, e.g. `@CurrentUser('userId')`.
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;
    return data && user ? user[data] : user;
  },
);
