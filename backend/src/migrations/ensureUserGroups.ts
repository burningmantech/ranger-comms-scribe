import { Env } from '../utils/sessionManager';
import { User } from '../types';

/**
 * Migration function to ensure all users have a groups array
 * This prevents errors when interacting with user.groups
 */
export const ensureUserGroups = async (env: Env): Promise<void> => {
  console.log('Starting migration: Ensuring all users have a groups array');
  
  try {
    // Get all users
    const objects = await env.R2.list({ prefix: 'user/' });
    console.log(`Found ${objects.objects.length} users to check`);
    
    let updatedCount = 0;
    
    for (const object of objects.objects) {
      const userData = await env.R2.get(object.key);
      if (!userData) continue;
      
      const user = await userData.json() as User;
      
      // Check if groups array is missing
      if (!user.groups) {
        // Add empty groups array
        user.groups = [];
        
        // Save the updated user
        await env.R2.put(object.key, JSON.stringify(user), {
          httpMetadata: { contentType: 'application/json' },
          customMetadata: { userId: user.id }
        });
        
        updatedCount++;
        console.log(`Updated user: ${user.id} (${user.email})`);
      }
    }
    
    console.log(`Migration completed successfully. Updated ${updatedCount} users.`);
  } catch (error) {
    console.error('Error during migration:', error);
    throw error;
  }
};
