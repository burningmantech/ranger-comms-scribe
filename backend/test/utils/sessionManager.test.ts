import { CreateSession, GetSession, DeleteSession } from '../../src/utils/sessionManager';
import { mockEnv, setupMockStorage } from '../utils/test-helpers';

describe('Session Manager', () => {
  let env: any;

  beforeEach(() => {
    jest.clearAllMocks();
    env = mockEnv();
    
    // Mock Date.now() to return a fixed timestamp
    jest.spyOn(Date, 'now').mockImplementation(() => 1617984000000); // 2021-04-09T12:00:00.000Z
    
    // Mock crypto.randomUUID() to return a predictable session ID for testing
    global.crypto = {
      ...global.crypto,
      randomUUID: jest.fn().mockReturnValue('test-session-id')
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('CreateSession', () => {
    it('should create a session with the correct data', async () => {
      const userId = 'test-user-id';
      const sessionData = { name: 'Test User', email: 'test@example.com' };
      
      const sessionId = await CreateSession(userId, sessionData, env);
      
      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');
      expect(sessionId).toBe('test-session-id');
      
      // Verify session was stored in R2
      expect(env.R2.put).toHaveBeenCalled();
      
      const callArgs = env.R2.put.mock.calls[0];
      expect(callArgs[0]).toBe(`session/${sessionId}`);
      
      const storedData = JSON.parse(callArgs[1]);
      expect(storedData.userId).toBe(userId);
      expect(storedData.data).toEqual(sessionData);
      expect(storedData.expiresAt).toBe(Date.now() + 864000 * 1000); // Default TTL
      
      // Check metadata
      expect(callArgs[2].httpMetadata.contentType).toBe('application/json');
      expect(callArgs[2].customMetadata.userId).toBe(userId);
    });
    
    it('should use custom TTL when provided', async () => {
      const userId = 'test-user-id';
      const sessionData = { name: 'Test User', email: 'test@example.com' };
      const customTTL = 3600; // 1 hour in seconds
      
      const sessionId = await CreateSession(userId, sessionData, env, customTTL);
      
      const callArgs = env.R2.put.mock.calls[0];
      const storedData = JSON.parse(callArgs[1]);
      
      expect(storedData.expiresAt).toBe(Date.now() + customTTL * 1000);
    });
  });

  describe('GetSession', () => {
    it('should retrieve a valid session', async () => {
      const sessionId = 'test-session-id';
      const userId = 'user123';
      const sessionData = {
        userId,
        data: { name: 'Test User', role: 'admin' },
        expiresAt: Date.now() + 3600000 // 1 hour in the future
      };
      
      env.R2.get.mockResolvedValue({
        json: () => Promise.resolve(sessionData)
      });
      
      const result = await GetSession(sessionId, env);
      
      expect(result).toEqual(sessionData);
      expect(env.R2.get).toHaveBeenCalledWith(`session/${sessionId}`);
    });
    
    it('should return null for non-existent session', async () => {
      const sessionId = 'non-existent-session';
      
      env.R2.get.mockResolvedValue(null);
      
      const result = await GetSession(sessionId, env);
      
      expect(result).toBeNull();
      expect(env.R2.get).toHaveBeenCalledWith(`session/${sessionId}`);
    });
    
    it('should delete and return null for expired session', async () => {
      const sessionId = 'expired-session-id';
      const userId = 'user123';
      const sessionData = {
        userId,
        data: { name: 'Test User', role: 'admin' },
        expiresAt: Date.now() - 3600000 // 1 hour in the past
      };
      
      env.R2.get.mockResolvedValue({
        json: () => Promise.resolve(sessionData)
      });
      
      const result = await GetSession(sessionId, env);
      
      expect(result).toBeNull();
      expect(env.R2.get).toHaveBeenCalledWith(`session/${sessionId}`);
      expect(env.R2.delete).toHaveBeenCalledWith(`session/${sessionId}`);
    });
  });

  describe('DeleteSession', () => {
    it('should delete a session from R2 storage', async () => {
      const sessionId = 'test-session-id';
      
      await DeleteSession(sessionId, env);
      
      expect(env.R2.delete).toHaveBeenCalledWith(`session/${sessionId}`);
    });
    
    it('should not throw error when deleting non-existent session', async () => {
      await expect(DeleteSession('nonexistent-session-id', env)).resolves.not.toThrow();
      
      expect(env.R2.delete).toHaveBeenCalledWith('session/nonexistent-session-id');
    });
  });
});