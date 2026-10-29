import type { FastifyInstance, FastifyRequest } from 'fastify';
import { StaffAuth, authBody, invalidCredentials } from './staff-auth.ts';
import type { StaffAuthConfig } from './staff-auth-config.ts';
export function bearer(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ') || header.length > 8200 || !header.slice(7)) throw invalidCredentials();
  return header.slice(7);
}
export function registerStaffAuth(app: FastifyInstance, config: StaffAuthConfig): StaffAuth {
  const auth = new StaffAuth(config, event => app.log.error({ event }));
  app.addHook('onClose', async () => {
    await auth.database.end();
  });
  for (const prefix of ['/auth', '/mad/auth']) {
    const system = prefix === '/mad/auth' ? 'mad' : undefined;
    app.post(prefix + '/login', request =>
      auth.safely(() => {
        const body = authBody(request.body, ['username', 'password', 'subsystem']);
        return auth.login(body, system ?? body.subsystem);
      })
    );
    app.get(prefix + '/session', request => auth.safely(() => auth.session(bearer(request), system)));
    app.post(prefix + '/logout', request =>
      auth.safely(async () => {
        const token = bearer(request);
        await auth.session(token, system);
        return auth.logout(token);
      })
    );
    app.post(prefix + '/change-password', request =>
      auth.safely(async () => {
        const token = bearer(request);
        await auth.session(token, system);
        return auth.changePassword(token, authBody(request.body, ['currentPassword', 'newPassword']));
      })
    );
    app.post(prefix + '/request-password-reset', request =>
      auth.safely(() => auth.requestReset(authBody(request.body, ['email']).email))
    );
    app.post(prefix + '/reset-password', request =>
      auth.safely(() => auth.resetPassword(authBody(request.body, ['email', 'code', 'newPassword'])))
    );
  }
  return auth;
}
