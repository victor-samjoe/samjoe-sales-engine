import 'dotenv/config';

export type AppConfig = {
  nodeEnv: string;
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  jwtSecret: string;
  jwtExpiresIn: string;
};

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const jwtSecret = required('JWT_SECRET', env.JWT_SECRET);
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must have at least 32 characters');

  const port = Number(env.PORT ?? '4010');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid TCP port');
  }

  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    host: env.HOST ?? '0.0.0.0',
    port,
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl: required('DATABASE_URL', env.DATABASE_URL),
    jwtSecret,
    jwtExpiresIn: env.JWT_EXPIRES_IN ?? '8h',
  };
}

