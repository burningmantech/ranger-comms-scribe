import { Env } from '../utils/sessionManager';
import { User } from '../types';

// Store users in R2 with prefix 'user:'
export async function createUser({ name, email }: { name: string; email: string }, env: Env): Promise<User> {
  // Check if user already exists
  const existingUser = await getUserByEmail(email, env);
  if (existingUser) {
    return existingUser;
  }
  
  // Create a new user
  const id = `user-${Date.now()}`;
  const newUser: User = { 
    id, 
    name, 
    email, 
    approved: false, 
    isAdmin: email === 'alexander.young@gmail.com' // First admin
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
  
  // Update in R2
  await env.R2.put(`user:${user.email}`, JSON.stringify(user), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { userId: id }
  });
  
  return user;
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
    if (newAdmin && !newAdmin.isAdmin) {
      newAdmin.isAdmin = true;
      newAdmin.approved = true;
      
      await env.R2.put(`user:${adminEmail}`, JSON.stringify(newAdmin), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { userId: newAdmin.id }
      });
    }
  }
}
