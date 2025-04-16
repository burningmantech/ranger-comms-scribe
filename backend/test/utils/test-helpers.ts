// Define the R2Bucket interface for testing
interface R2Bucket {
  get: jest.Mock;
  put: jest.Mock;
  delete: jest.Mock;
  list: jest.Mock;
  head?: jest.Mock;
}

// Define the Env interface for testing purposes
interface Env {
  R2: R2Bucket;
  ENV: {
    SESSION_SECRET: string;
    ADMIN_EMAIL: string;
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
    AWS_REGION: string;
    EMAIL_FROM: string;
  };
  SESSION_STORE: {
    get: jest.Mock;
    put: jest.Mock;
    delete: jest.Mock;
  };
}

export const mockEnv = (): Env => {
  const mockStorage = new Map<string, string>();
  
  return {
    R2: {
      get: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
      list: jest.fn(),
      head: jest.fn(),
    },
    ENV: {
      SESSION_SECRET: 'test-secret',
      ADMIN_EMAIL: 'admin@example.com',
      AWS_ACCESS_KEY_ID: 'test-key-id',
      AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      AWS_REGION: 'us-east-1',
      EMAIL_FROM: 'noreply@example.com',
    },
    SESSION_STORE: {
      get: jest.fn(async (key: string) => mockStorage.get(key)),
      put: jest.fn(async (key: string, value: string) => {
        mockStorage.set(key, value);
        return true;
      }),
      delete: jest.fn(async (key: string) => {
        mockStorage.delete(key);
        return true;
      }),
    }
  } as Env;
};

export const setupMockStorage = (sessionStore: Map<string, string>) => {
  return {
    get: jest.fn(async (key: string) => sessionStore.get(key)),
    put: jest.fn(async (key: string, value: string) => {
      sessionStore.set(key, value);
      return true;
    }),
    delete: jest.fn(async (key: string) => {
      sessionStore.delete(key);
      return true;
    }),
  };
};