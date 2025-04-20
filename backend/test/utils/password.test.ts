import { hashPassword, verifyPassword } from '../../src/utils/password';

describe('Password Utilities', () => {
  describe('hashPassword', () => {
    it('should hash a password', async () => {
      const password = 'test-password123';
      const hash = await hashPassword(password);
      
      // Verify hash is a non-empty string
      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash.length).toBeGreaterThan(0);
    });
    
    it('should generate different hashes for the same password', async () => {
      const password = 'test-password123';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);
      
      // Verify hashes are different (due to different salts)
      expect(hash1).not.toEqual(hash2);
    });
  });
  
  describe('verifyPassword', () => {
    it('should verify a correct password against its hash', async () => {
      const password = 'test-password123';
      const hash = await hashPassword(password);
      
      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });
    
    it('should reject an incorrect password', async () => {
      const password = 'test-password123';
      const wrongPassword = 'wrong-password';
      const hash = await hashPassword(password);
      
      const isValid = await verifyPassword(wrongPassword, hash);
      expect(isValid).toBe(false);
    });
    
    it('should handle invalid hash format', async () => {
      const password = 'test-password123';
      const invalidHash = 'invalid-hash';
      
      const isValid = await verifyPassword(password, invalidHash);
      expect(isValid).toBe(false);
    });
  });
});