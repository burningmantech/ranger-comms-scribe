import { Env } from '../utils/sessionManager';
import { User, UserType, Group } from '../types';

// Store users in R2 with prefix 'user:'
export async function createUser({ name, email }: { name: string; email: string }, env: Env): Promise<User> {
  // Check if user already exists
  const existingUser = await getUserByEmail(email, env);
  if (existingUser) {
    return existingUser;
  }
  
  // Create a new user
  const id = `user-${Date.now()}`;
  const isFirstAdmin = email === 'alexander.young@gmail.com';
  
  const newUser: User = { 
    id, 
    name, 
    email, 
    approved: false, 
    isAdmin: isFirstAdmin, // First admin
    userType: isFirstAdmin ? UserType.Admin : UserType.Public,
    groups: []
  };
  
  // Store in R2
  await env.R2.put(`user:${email}`, JSON.stringify(newUser), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { userId: id }
  });
  
  return newUser;
}

export async function getUser(id: string, env: Env): Promise<User | null> {
  // List all user objects and find by ID
  const objects = await env.R2.list({ prefix: 'user:' });
  
  for (const object of objects.objects) {
    const userData = await env.R2.get(object.key);
    if (!userData) continue;
    
    const user = await userData.json() as User;
    if (user.id === id) {
      return user;
    }
  }
  
  return null;
}

export async function getUserByEmail(email: string, env: Env): Promise<User | null> {
  const object = await env.R2.get(`user:${email}`);
  if (!object) return null;
  
  return await object.json() as User;
}

export async function approveUser(id: string, env: Env): Promise<User | null> {
  const user = await getUser(id, env);
  if (!user) return null;
  
  user.approved = true;
  
  // Update in R2
  await env.R2.put(`user:${user.email}`, JSON.stringify(user), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { userId: id }
  });
  
  return user;
}

export async function getAllUsers(env: Env): Promise<User[]> {
  const objects = await env.R2.list({ prefix: 'user:' });
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
  await env.R2.put(`user:${user.email}`, JSON.stringify(user), {
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
  await env.R2.put(`user:${user.email}`, JSON.stringify(user), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { userId: id }
  });
  
  return user;
}

// Create a new group
export async function createGroup(
  name: string, 
  description: string, 
  creatorId: string,
  env: Env
): Promise<Group | null> {
  // Get the creator to check permissions
  const creator = await getUser(creatorId, env);
  if (!creator) return null;
  
  // Only Admins and Leads can create groups
  if (creator.userType !== UserType.Admin && creator.userType !== UserType.Lead) {
    return null;
  }
  
  const id = `group-${Date.now()}`;
  const timestamp = new Date().toISOString();
  
  const newGroup: Group = {
    id,
    name,
    description,
    createdBy: creatorId,
    createdAt: timestamp,
    updatedAt: timestamp,
    members: [creatorId] // Creator is automatically a member
  };
  
  // Store in R2
  await env.R2.put(`group:${id}`, JSON.stringify(newGroup), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { createdBy: creatorId }
  });
  
  // Ensure creator.groups exists and is an array before pushing to it
  if (!creator.groups || !Array.isArray(creator.groups)) {
    creator.groups = [];
  }
  
  // Add group to creator's groups
  creator.groups.push(id);
  await env.R2.put(`user:${creator.email}`, JSON.stringify(creator), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { userId: creatorId }
  });
  
  return newGroup;
}

// Get a group by ID
export async function getGroup(id: string, env: Env): Promise<Group | null> {
  const object = await env.R2.get(`group:${id}`);
  if (!object) return null;
  
  return await object.json() as Group;
}

// Get all groups
export async function getAllGroups(env: Env): Promise<Group[]> {
  const objects = await env.R2.list({ prefix: 'group:' });
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
  const user = await getUser(userId, env);
  const group = await getGroup(groupId, env);
  
  if (!user || !group) return false;
  
  // Check if user is already in the group
  if (group.members.includes(userId)) return true;
  
  // Add user to group
  group.members.push(userId);
  group.updatedAt = new Date().toISOString();
  
  await env.R2.put(`group:${groupId}`, JSON.stringify(group), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { updatedAt: group.updatedAt }
  });
  
  // Ensure user.groups exists and add group to user's groups
  if (!user.groups) {
    user.groups = [];
  }
  
  if (!user.groups.includes(groupId)) {
    user.groups.push(groupId);
    
    await env.R2.put(`user:${user.email}`, JSON.stringify(user), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { userId: user.id }
    });
  }
  
  return true;
}

// Remove a user from a group
export async function removeUserFromGroup(userId: string, groupId: string, env: Env): Promise<boolean> {
  const user = await getUser(userId, env);
  const group = await getGroup(groupId, env);
  
  if (!user || !group) return false;
  
  // Check if user is in the group
  if (!group.members.includes(userId)) return true;
  
  // Remove user from group
  group.members = group.members.filter(id => id !== userId);
  group.updatedAt = new Date().toISOString();
  
  await env.R2.put(`group:${groupId}`, JSON.stringify(group), {
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
  
  await env.R2.put(`user:${user.email}`, JSON.stringify(user), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { userId: user.id }
  });
  
  return true;
}

// Delete a group
export async function deleteGroup(groupId: string, env: Env): Promise<boolean> {
  const group = await getGroup(groupId, env);
  if (!group) return false;
  
  // Get all users who are members of this group
  const users = await getAllUsers(env);
  const groupMembers = users.filter(user => 
    user.groups && user.groups.includes(groupId)
  );
  
  // Remove the group from all users' groups arrays
  for (const user of groupMembers) {
    if (user.groups) {
      user.groups = user.groups.filter(id => id !== groupId);
      
      await env.R2.put(`user:${user.email}`, JSON.stringify(user), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { userId: user.id }
      });
    }
  }
  
  // Delete the group from R2
  await env.R2.delete(`group:${groupId}`);
  
  return true;
}

// Check if a user can access a group's content
export async function canAccessGroup(userId: string, groupId: string, env: Env): Promise<boolean> {
  // Admins can access everything
  const user = await getUser(userId, env);
  if (!user) return false;
  
  if (user.userType === UserType.Admin) return true;
  
  // Ensure user.groups exists before checking
  if (!user.groups) {
    return false;
  }
  
  // Check if user is a member of the group
  return user.groups.includes(groupId);
}

export async function isAdmin(email: string, env: Env): Promise<boolean> {
  const user = await getUserByEmail(email, env);
  return user ? user.isAdmin : false;
}

// Initialize first admin if not exists
export async function initializeFirstAdmin(env: Env): Promise<void> {
  const adminEmail = 'alexander.young@gmail.com';
  const admin = await getUserByEmail(adminEmail, env);
  
  if (!admin) {
    await createUser({ 
      name: 'Alexander Young', 
      email: adminEmail 
    }, env);
    
    // Ensure admin privileges
    const newAdmin = await getUserByEmail(adminEmail, env);
    if (newAdmin && (!newAdmin.isAdmin || newAdmin.userType !== UserType.Admin)) {
      newAdmin.isAdmin = true;
      newAdmin.approved = true;
      newAdmin.userType = UserType.Admin;
      
      await env.R2.put(`user:${adminEmail}`, JSON.stringify(newAdmin), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { userId: newAdmin.id }
      });
    }
  }
}
