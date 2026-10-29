export interface StaffAuthConfig {
  databaseUrl: string;
  ssl: boolean;
  secret: string;
  issuer: string;
  emailEnabled: boolean;
  sendgridKey: string;
  sender: string;
}
export function staffAuthConfig(env: NodeJS.ProcessEnv): StaffAuthConfig | undefined {
  if (env.STAFF_AUTH_ENABLED !== 'true') {
    if (env.STAFF_AUTH_ENABLED && env.STAFF_AUTH_ENABLED !== 'false') throw new Error('Invalid STAFF_AUTH_ENABLED');
    return undefined;
  }
  let databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    for (const name of ['DB_HOST', 'DB_USERNAME', 'DB_PASSWORD', 'DB_NAME'])
      if (!env[name]) throw new Error('Missing gateway ' + name);
    if (!/^[a-zA-Z0-9.-]+$/.test(env.DB_HOST!)) throw new Error('Invalid DB_HOST');
    const port = Number(env.DB_PORT ?? 5432);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DB_PORT');
    databaseUrl = `postgresql://${encodeURIComponent(env.DB_USERNAME!)}:${encodeURIComponent(env.DB_PASSWORD!)}@${env.DB_HOST}:${port}/${encodeURIComponent(env.DB_NAME!)}`;
  }
  if (!['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol)) throw new Error('Invalid DATABASE_URL');
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32 || !env.JWT_ISSUER)
    throw new Error('Gateway JWT_SECRET and JWT_ISSUER are required');
  if (env.DB_SSL && !['true', 'false'].includes(env.DB_SSL)) throw new Error('Invalid DB_SSL');
  if (env.STAFF_EMAIL_ENABLED && !['true', 'false'].includes(env.STAFF_EMAIL_ENABLED))
    throw new Error('Invalid STAFF_EMAIL_ENABLED');
  const emailEnabled = env.STAFF_EMAIL_ENABLED === 'true';
  if (emailEnabled && (!env.SENDGRID_API_KEY || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.SENDGRID_FROM_EMAIL ?? '')))
    throw new Error('Email requires SendGrid API key and verified sender');
  return {
    databaseUrl,
    ssl: env.DB_SSL === 'true',
    secret: env.JWT_SECRET,
    issuer: env.JWT_ISSUER,
    emailEnabled,
    sendgridKey: env.SENDGRID_API_KEY ?? '',
    sender: env.SENDGRID_FROM_EMAIL ?? ''
  };
}
