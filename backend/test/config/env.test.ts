import { loadConfig, parseCsv, parsePort, DEFAULT_EMAIL_FROM } from '../../src/config/env';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';
import { S3ObjectStore } from '../../src/storage/s3ObjectStore';

const REQUIRED = {
  PUBLIC_URL: 'https://aws-dev.example.com/api',
  FRONTEND_URL: 'https://aws-dev.example.com',
  GOOGLE_CLIENT_ID: 'client-id',
  TURNSTILESECRET: 'turnstile',
};

describe('parseCsv', () => {
  it('splits, trims and drops empty entries', () => {
    expect(parseCsv('a@x.com, b@x.com ,,c@x.com,')).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });

  it('returns [] for empty or missing values', () => {
    expect(parseCsv(undefined)).toEqual([]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv(' , ')).toEqual([]);
  });
});

describe('parsePort', () => {
  it('defaults to 8080', () => {
    expect(parsePort(undefined)).toBe(8080);
    expect(parsePort('')).toBe(8080);
  });

  it('parses a valid port and rejects garbage', () => {
    expect(parsePort('8099')).toBe(8099);
    expect(() => parsePort('abc')).toThrow('Invalid PORT');
    expect(() => parsePort('70000')).toThrow('Invalid PORT');
  });
});

describe('loadConfig', () => {
  it('applies defaults', () => {
    const { env, port, storeDriver } = loadConfig({ ...REQUIRED, DATA_BUCKET: 'bucket' });
    expect(port).toBe(8080);
    expect(storeDriver).toBe('s3');
    expect(env.STORE).toBeInstanceOf(S3ObjectStore);
    expect(env.SES_REGION).toBe('us-east-1');
    expect(env.EMAIL_FROM).toBe(DEFAULT_EMAIL_FROM);
    expect(env.EMAIL_BCC).toEqual([]);
    expect(env.BOOTSTRAP_ADMIN_EMAILS).toEqual([]);
    expect(env.CORS_ORIGINS).toEqual(['https://aws-dev.example.com', 'http://localhost:3000']);
    expect(env.DEV_BYPASS_AUTH).toBeUndefined();
    expect(env.PUBLIC_URL).toBe(REQUIRED.PUBLIC_URL);
    expect(env.GOOGLE_CLIENT_ID).toBe('client-id');
    expect(env.TURNSTILESECRET).toBe('turnstile');
  });

  it('parses the CSV variables and overrides', () => {
    const { env, port } = loadConfig({
      ...REQUIRED,
      DATA_BUCKET: 'bucket',
      PORT: '9000',
      CORS_ORIGINS: 'https://a.example, https://b.example',
      EMAIL_BCC: 'audit@example.org, ',
      EMAIL_FROM: 'Scribe <noreply@example.org>',
      SES_REGION: 'us-west-2',
      BOOTSTRAP_ADMIN_EMAILS: 'Boss@Example.com, second@example.com',
      DEV_BYPASS_AUTH: 'true',
    });
    expect(port).toBe(9000);
    expect(env.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
    expect(env.EMAIL_BCC).toEqual(['audit@example.org']);
    expect(env.EMAIL_FROM).toBe('Scribe <noreply@example.org>');
    expect(env.SES_REGION).toBe('us-west-2');
    expect(env.BOOTSTRAP_ADMIN_EMAILS).toEqual(['boss@example.com', 'second@example.com']);
    expect(env.DEV_BYPASS_AUTH).toBe('true');
  });

  it('uses a MemoryObjectStore with STORE_DRIVER=memory (no DATA_BUCKET needed)', () => {
    const { env, storeDriver } = loadConfig({ ...REQUIRED, STORE_DRIVER: 'memory' });
    expect(storeDriver).toBe('memory');
    expect(env.STORE).toBeInstanceOf(MemoryObjectStore);
  });

  it('lists every missing required variable', () => {
    expect(() => loadConfig({})).toThrow(
      'Missing required environment variables: PUBLIC_URL, FRONTEND_URL, GOOGLE_CLIENT_ID, TURNSTILESECRET, DATA_BUCKET'
    );
    expect(() => loadConfig({ ...REQUIRED, DATA_BUCKET: '  ' })).toThrow('DATA_BUCKET');
  });

  it('rejects an unknown STORE_DRIVER', () => {
    expect(() => loadConfig({ ...REQUIRED, STORE_DRIVER: 'r2' })).toThrow('Invalid STORE_DRIVER');
  });

  it('accepts an injected store', () => {
    const store = new MemoryObjectStore();
    expect(loadConfig(REQUIRED, { store }).env.STORE).toBe(store);
  });
});
