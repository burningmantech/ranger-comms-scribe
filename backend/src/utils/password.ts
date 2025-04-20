// Secure password handling utilities for Cloudflare Workers using crypto.subtle
// This implements PBKDF2 with SHA-256 for password hashing

/**
 * Hashes a password using PBKDF2 with a random salt
 * @param password The plaintext password to hash
 * @returns Base64 string containing the salt and hash
 */
export async function hashPassword(password: string): Promise<string> {
  // Convert password to buffer
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);
  
  // Generate a cryptographically secure random salt (16 bytes)
  const salt = crypto.getRandomValues(new Uint8Array(16));
  
  // Use PBKDF2 with suitable iterations
  const key = await crypto.subtle.importKey(
    'raw', 
    passwordBuffer, 
    { name: 'PBKDF2' }, 
    false, 
    ['deriveBits']
  );
  
  const hash = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000, // High iteration count for security
      hash: 'SHA-256'
    },
    key,
    256 // 256 bits hash
  );
  
  // Combine salt and hash for storage
  const result = new Uint8Array(salt.length + hash.byteLength);
  result.set(salt, 0);
  result.set(new Uint8Array(hash), salt.length);
  
  // Convert to base64 for storage
  return btoa(String.fromCharCode(...result));
}

/**
 * Verifies a password against a stored hash
 * @param password The plaintext password to verify
 * @param storedHash The stored hash from hashPassword()
 * @returns Boolean indicating if the password matches
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    // Decode the stored hash
    const hashBuffer = Uint8Array.from(atob(storedHash), c => c.charCodeAt(0));
    
    // Extract salt (first 16 bytes)
    const salt = hashBuffer.slice(0, 16);
    
    // Extract hash (remaining bytes)
    const originalHash = hashBuffer.slice(16);
    
    // Convert password to buffer
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);
    
    // Import key material
    const key = await crypto.subtle.importKey(
      'raw', 
      passwordBuffer, 
      { name: 'PBKDF2' }, 
      false, 
      ['deriveBits']
    );
    
    // Generate hash with same parameters
    const compareHash = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      key,
      256
    );
    
    // Compare hashes (constant-time comparison to prevent timing attacks)
    const newHashArray = new Uint8Array(compareHash);
    
    if (originalHash.length !== newHashArray.length) {
      return false;
    }
    
    let result = 0;
    for (let i = 0; i < originalHash.length; i++) {
      result |= originalHash[i] ^ newHashArray[i];
    }
    
    return result === 0;
  } catch (err) {
    console.error('Error verifying password:', err);
    return false;
  }
}