import { Env } from '../utils/sessionManager';
import { User, UserType, Group } from '../types';
import { hashPassword, verifyPassword } from '../utils/password';

// Store users in R2 with prefix 'user:'
export async function getOrCreateUser({ name, email, password }: { name: string; email: string; password?: string }, env: Env): Promise<User> {
  // Check if user already exists
  const existingUser = await getUser(email, env);
  if (existingUser) {
    return existingUser;
  }
  
  const id = email
  
  const newUser: User = { 
    id, 
    name, 
    email, 
    approved: false, 
    isAdmin: false,
    userType: UserType.Public,
    groups: []
  };

  // If password is provided, hash it and store it
  if (password) {
    newUser.passwordHash = await hashPassword(password);
  }
  
  // Store in R2
  await env.R2.put(`user/${email}`, JSON.stringify(newUser), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { userId: id }
  });
  
  return newUser;
}

export async function getUser(email: string, env: Env): Promise<User | null>  {
  // Check if user already exists
  const existingUser = await getUserInternal(email, env);
  if (existingUser) {
    return existingUser;
  }

  const isFirstAdmin = email === 'alexander.young@gmail.com';

  if (isFirstAdmin) {
    const newUser: User = { 
      id: email, 
      name: "Alex Young", 
      email, 
      approved: true, 
      isAdmin: true,
      userType: UserType.Admin,
      groups: []
    };
    
    // Store in R2
    await env.R2.put(`user/${email}`, JSON.stringify(newUser), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { userId: email }
    });
    
    return newUser;
  }

  return null
}

export async function getUserInternal(id: string, env: Env): Promise<User | null> {
  try {
    if (!id) return null;
    
    const object = await env.R2.get(`user/${id}`);
    if (!object) return null;
    
    const user = await object.json() as User;
    
    // Ensure user has a groups array
    if (!user.groups) {
      user.groups = [];
    }
    
    return user;
  } catch (error) {
    console.error(`Error fetching user ${id}:`, error);
    return null;
  }
}

export async function approveUser(id: string, env: Env): Promise<User | null> {
  const user = await getUser(id, env);
  if (!user) return null;
  
  user.approved = true;
  
  // Update in R2
  await env.R2.put(`user/${user.email}`, JSON.stringify(user), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { userId: id }
  });
  
  return user;
}

export async function getAllUsers(env: Env): Promise<User[]> {
  const objects = await env.R2.list({ prefix: 'user/' });
  const users: User[] = [];
  
  for (const object of objects.objects) {
    const userData = await env.R2.get(object.key);
    if (!userData) continue;
    
    const user = await userData.json() as User;
    users.push(user);
  }
  
  return users;
}

export async function makeAdmin(id: string, env: Env): Promise<User | null> {
  const user = await getUser(id, env);
  if (!user) return null;
  
  user.isAdmin = true;
  user.userType = UserType.Admin;
  
  // Update in R2
  await env.R2.put(`user/${user.email}`, JSON.stringify(user), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { userId: id }
  });
  
  return user;
}

// Change a user's type
export async function changeUserType(id: string, userType: UserType, env: Env): Promise<User | null> {
  const user = await getUser(id, env);
  if (!user) return null;
  
  user.userType = userType;
  
  // If changing to Admin, also set isAdmin flag for backward compatibility
  if (userType === UserType.Admin) {
    user.isAdmin = true;
  } else if (user.isAdmin) {
    // If demoting from Admin, remove isAdmin flag
    user.isAdmin = false;
  }
  
  // Update in R2
  await env.R2.put(`user/${user.email}`, JSON.stringify(user), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { userId: id }
  });
  
  return user;
}

// Add a group to a user's groups array
async function addGroupToUser(userId: string, groupId: string, env: Env): Promise<boolean> {
  try {
    if (!userId || !groupId) return false;
    
    const user = await getUser(userId, env);
    if (!user) return false;
    
    // Ensure user.groups exists
    if (!user.groups) {
      user.groups = [];
    }
    
    // Add group to user's groups if not already there
    if (!user.groups.includes(groupId)) {
      user.groups.push(groupId);
      
      await env.R2.put(`user/${user.email}`, JSON.stringify(user), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { userId: user.id }
      });
    }
    
    return true;
  } catch (error) {
    console.error(`Error adding group ${groupId} to user ${userId}:`, error);
    return false;
  }
}

// Create a new user group
export async function createGroup(
  name: string,
  description: string,
  createdBy: string,
  env: Env
): Promise<Group | null> {
  try {
    // Verify the creator is allowed to create groups (admin or lead)
    const user = await getUser(createdBy, env);
    if (!user) return null;
    
    if (!user.isAdmin && user.userType !== UserType.Lead) {
      return null;
    }
    
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    
    const group: Group = {
      id,
      name,
      description,
      createdBy,
      createdAt: now,
      updatedAt: now, // Add the required updatedAt field
      members: [createdBy], // Creator is automatically a member
    };
    
    // Store the group in R2 using both key formats for consistency
    await env.R2.put(`group/${id}`, JSON.stringify(group));
    await env.R2.put(`groups/${id}`, JSON.stringify(group));
    
    // Update the creator's groups
    await addGroupToUser(createdBy, id, env);
    
    return group;
  } catch (error) {
    console.error('Error creating group:', error);
    return null;
  }
}

// Get a group by ID
export async function getGroup(id: string, env: Env): Promise<Group | null> {
  try {
    if (!id) return null;

    // First try with singular "group/" prefix
    let object = await env.R2.get(`group/${id}`);
    
    // If not found, try with plural "groups/" prefix (for compatibility with test environment)
    if (!object) {
      object = await env.R2.get(`groups/${id}`);
    }
    
    if (!object) return null;
    
    const group = await object.json() as Group;
    
    // Ensure members is an array
    if (!group.members) {
      group.members = [];
    }
    
    return group;
  } catch (error) {
    console.error(`Error fetching group ${id}:`, error);
    return null;
  }
}

// Get all groups
export async function getAllGroups(env: Env): Promise<Group[]> {
  const objects = await env.R2.list({ prefix: 'group/' });
  const groups: Group[] = [];
  
  for (const object of objects.objects) {
    const groupData = await env.R2.get(object.key);
    if (!groupData) continue;
    
    const group = await groupData.json() as Group;
    groups.push(group);
  }
  
  return groups;
}

// Add a user to a group
export async function addUserToGroup(userId: string, groupId: string, env: Env): Promise<boolean> {
  try {
    if (!userId || !groupId) return false;
    
    const user = await getUser(userId, env);
    const group = await getGroup(groupId, env);
    
    if (!user || !group) return false;
    
    // Check if user is already in the group
    if (group.members.includes(userId)) return true;
    
    // Add user to group
    group.members.push(userId);
    group.updatedAt = new Date().toISOString();
    
    await env.R2.put(`group/${groupId}`, JSON.stringify(group), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { updatedAt: group.updatedAt }
    });
    
    // Ensure user.groups exists and add group to user's groups
    if (!user.groups) {
      user.groups = [];
    }
    
    if (!user.groups.includes(groupId)) {
      user.groups.push(groupId);
      
      await env.R2.put(`user/${user.email}`, JSON.stringify(user), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { userId: user.id }
      });
    }
    
    return true;
  } catch (error) {
    console.error(`Error adding user ${userId} to group ${groupId}:`, error);
    return false;
  }
}

// Remove a user from a group
export async function removeUserFromGroup(userId: string, groupId: string, env: Env): Promise<boolean> {
  try {
    if (!userId || !groupId) return false;
    
    const user = await getUser(userId, env);
    const group = await getGroup(groupId, env);
    
    if (!user || !group) return false;
    
    // Check if user is in the group
    if (!group.members.includes(userId)) return true;
    
    // Remove user from group
    group.members = group.members.filter(id => id !== userId);
    group.updatedAt = new Date().toISOString();
    
    await env.R2.put(`group/${groupId}`, JSON.stringify(group), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { updatedAt: group.updatedAt }
    });
    
    // Ensure user.groups exists before filtering
    if (!user.groups) {
      user.groups = [];
    } else {
      // Remove group from user's groups
      user.groups = user.groups.filter(id => id !== groupId);
    }
    
    await env.R2.put(`user/${user.email}`, JSON.stringify(user), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { userId: user.id }
    });
    
    return true;
  } catch (error) {
    console.error(`Error removing user ${userId} from group ${groupId}:`, error);
    return false;
  }
}

// Delete a group
export async function deleteGroup(groupId: string, env: Env): Promise<boolean> {
  try {
    const group = await getGroup(groupId, env);
    if (!group) return false;
    
    // Get all users who might have this group in their groups array
    const users = await getAllUsers(env);
    
    // Remove the group from all users' groups arrays and update storage
    const userUpdatePromises = users.map(async user => {
      if (user.groups && user.groups.includes(groupId)) {
        // Filter out the group ID from the user's groups array
        user.groups = user.groups.filter(id => id !== groupId);
        
        // Save the updated user back to R2
        await env.R2.put(`user/${user.email}`, JSON.stringify(user), {
          httpMetadata: { contentType: 'application/json' },
          customMetadata: { userId: user.id }
        });
      }
    });
    
    // Wait for all user updates to complete
    await Promise.all(userUpdatePromises);
    
    // Delete the group from R2 (try both key formats for consistency)
    await env.R2.delete(`group/${groupId}`);
    await env.R2.delete(`groups/${groupId}`);
    
    return true;
  } catch (error) {
    console.error(`Error deleting group ${groupId}:`, error);
    return false;
  }
}

// Delete a user
export async function deleteUser(userId: string, env: Env): Promise<boolean> {
  const user = await getUser(userId, env);
  if (!user) return false;
  
  // Remove user from all groups they belong to
  if (user.groups && user.groups.length > 0) {
    for (const groupId of user.groups) {
      const group = await getGroup(groupId, env);
      if (group) {
        // Remove user from group members
        group.members = group.members.filter(id => id !== userId);
        group.updatedAt = new Date().toISOString();
        
        await env.R2.put(`group/${groupId}`, JSON.stringify(group), {
          httpMetadata: { contentType: 'application/json' },
          customMetadata: { updatedAt: group.updatedAt }
        });
      }
    }
  }
  
  // Delete the user from R2
  await env.R2.delete(`user/${user.email}`);
  
  return true;
}

// Check if a user can access a group's content
export async function canAccessGroup(userId: string, groupId: string, env: Env): Promise<boolean> {
  try {
    // Basic parameter validation
    if (!userId || !groupId) return false;

    // Admins can access everything - we check this first before trying to get the group
    const user = await getUser(userId, env);
    if (!user) return false;
    
    if (user.isAdmin || user.userType === UserType.Admin) return true;
    
    // Check if the group exists
    const group = await getGroup(groupId, env);
    if (!group) return false;
    
    // Check if user is a member of the group using the group's members list
    return Array.isArray(group.members) && group.members.includes(userId);
  } catch (error) {
    console.error(`Error checking access for user ${userId} to group ${groupId}:`, error);
    return false;
  }
}

export async function isAdmin(id: string, env: Env): Promise<boolean> {
  const user = await getUser(id, env);
  return user ? user.isAdmin : false;
}

// Initialize first admin if not exists
export async function initializeFirstAdmin(env: Env): Promise<void> {
  const adminEmail = 'alexander.young@gmail.com';
  const admin = await getUser(adminEmail, env);
  
  if (!admin) {
    await getOrCreateUser({ 
      name: 'Alexander Young', 
      email: adminEmail 
    }, env);
    
    // Ensure admin privileges
    const newAdmin = await getUser(adminEmail, env);
    if (newAdmin && (!newAdmin.isAdmin || newAdmin.userType !== UserType.Admin)) {
      newAdmin.isAdmin = true;
      newAdmin.approved = true;
      newAdmin.userType = UserType.Admin;
      
      await env.R2.put(`user/${adminEmail}`, JSON.stringify(newAdmin), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { userId: newAdmin.id }
      });
    }
  }
}

// Update a user's notification settings
export async function updateUserNotificationSettings(
  userId: string, 
  notificationSettings: {
    notifyOnReplies: boolean;
    notifyOnGroupContent: boolean;
  },
  env: Env
): Promise<User | null> {
  const user = await getUser(userId, env);
  if (!user) return null;
  
  // Update notification settings
  user.notificationSettings = notificationSettings;
  
  // Update in R2
  await env.R2.put(`user/${user.email}`, JSON.stringify(user), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { userId: user.id }
  });
  
  return user;
}

// Get a user's notification settings (with defaults if not set)
export async function getUserNotificationSettings(
  userId: string,
  env: Env
): Promise<{ notifyOnReplies: boolean; notifyOnGroupContent: boolean }> {
  const user = await getUser(userId, env);
  
  // Default settings if user not found or no settings exist
  if (!user || !user.notificationSettings) {
    return {
      notifyOnReplies: true,
      notifyOnGroupContent: true
    };
  }
  
  // Return user's settings with defaults for any missing properties
  return {
    notifyOnReplies: user.notificationSettings.notifyOnReplies ?? true,
    notifyOnGroupContent: user.notificationSettings.notifyOnGroupContent ?? true
  };
}

// Add or update user password
export async function setUserPassword(userId: string, password: string, env: Env): Promise<boolean> {
  try {
    const user = await getUser(userId, env);
    if (!user) return false;
    
    // Hash the password
    user.passwordHash = await hashPassword(password);
    
    // Update user in storage
    await env.R2.put(`user/${user.email}`, JSON.stringify(user), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { userId: user.id }
    });
    
    return true;
  } catch (error) {
    console.error(`Error setting password for user ${userId}:`, error);
    return false;
  }
}

// Authenticate user with email and password
export async function authenticateUser(email: string, password: string, env: Env): Promise<User | null> {
  try {
    const user = await getUser(email, env);
    if (!user || !user.passwordHash) return null;
    
    // Verify the password
    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) return null;
    
    return user;
  } catch (error) {
    console.error(`Error authenticating user ${email}:`, error);
    return null;
  }
}

// Add a new function to mark a user as verified
export async function markUserAsVerified(userId: string, env: Env): Promise<User | null> {
  const user = await getUser(userId, env);
  if (!user) return null;
  
  // Mark as verified
  user.verified = true;
  
  // Update in R2
  await env.R2.put(`user/${user.email}`, JSON.stringify(user), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { userId: user.id }
  });
  
  return user;
}

// Update a user's name
export async function updateUserName(userId: string, newName: string, env: Env): Promise<User | null> {
  try {
    const user = await getUser(userId, env);
    if (!user) return null;
    
    // Update the name
    user.name = newName;
    
    // Update in R2
    await env.R2.put(`user/${user.email}`, JSON.stringify(user), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { userId: user.id }
    });
    
    return user;
  } catch (error) {
    console.error(`Error updating name for user ${userId}:`, error);
    return null;
  }
}
