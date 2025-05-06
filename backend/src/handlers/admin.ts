import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { 
  getAllUsers, 
  approveUser, 
  makeAdmin, 
  isAdmin, 
  changeUserType,
  createGroup,
  getAllGroups,
  getGroup,
  addUserToGroup,
  removeUserFromGroup,
  deleteGroup,
  getOrCreateUser,
  deleteUser,
  updateUserName
} from '../services/userService';
import { sendEmail } from '../utils/email';
import { UserType } from '../types';
import { GetSession, Env } from '../utils/sessionManager';
import { withAdminCheck } from '../authWrappers';

export const router = AutoRouter({ base: '/admin' });

// Get all users
router.get('/users', withAdminCheck, async (request: Request, env: Env) => {
  const users = await getAllUsers(env);
  return json({ users });
});

// Update a user's name - Endpoint for frontend compatibility
router.post('/update-user-name', withAdminCheck, async (request: Request, env: Env) => {
  const body = await request.json() as { userId: string; name: string };
  const { userId, name } = body;
  
  if (!userId) {
    return json({ error: 'User ID is required' }, { status: 400 });
  }

  if (!name || name.trim() === '') {
    return json({ error: 'A valid name is required' }, { status: 400 });
  }

  const updatedUser = await updateUserName(userId, name, env);
  if (!updatedUser) {
    return json({ error: 'User not found or update failed' }, { status: 404 });
  }

  return json({ 
    message: 'User name updated successfully', 
    user: updatedUser 
  });
});

// Approve a user
router.post('/approve-user', withAdminCheck, async (request: Request, env: Env) => {
  const body = await request.json() as { userId: string };
  const { userId } = body;

  if (!userId) {
    return json({ error: 'User ID is required' }, { status: 400 });
  }

  const updatedUser = await approveUser(userId, env);
  if (!updatedUser) {
    return json({ error: 'User not found' }, { status: 404 });
  }

  return json({ message: 'User approved successfully', user: updatedUser });
});

// Make a user an admin
router.post('/make-admin', withAdminCheck, async (request: Request, env: Env) => {
  const body = await request.json() as { userId: string };
  const { userId } = body;

  if (!userId) {
    return json({ error: 'User ID is required' }, { status: 400 });
  }

  const updatedUser = await makeAdmin(userId, env);
  if (!updatedUser) {
    return json({ error: 'User not found' }, { status: 404 });
  }

  return json({ message: 'User is now an admin', user: updatedUser });
});

// Change a user's type
router.post('/change-user-type', withAdminCheck, async (request: Request, env: Env) => {
  const body = await request.json() as { userId: string; userType: UserType };
  const { userId, userType } = body;

  if (!userId || !userType) {
    return json({ error: 'User ID and user type are required' }, { status: 400 });
  }

  // Validate user type
  if (!Object.values(UserType).includes(userType)) {
    return json({ error: 'Invalid user type' }, { status: 400 });
  }

  const updatedUser = await changeUserType(userId, userType, env);
  if (!updatedUser) {
    return json({ error: 'User not found' }, { status: 404 });
  }

  return json({ message: `User type changed to ${userType}`, user: updatedUser });
});

// Create a new group
router.post('/groups', withAdminCheck, async (request: Request, env: Env) => {
  const body = await request.json() as { name: string; description: string };
  const { name, description } = body;

  if (!name) {
    return json({ error: 'Group name is required' }, { status: 400 });
  }

  // Get the creator's ID from the session
  const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!sessionId) {
    return json({ error: 'Session ID is required' }, { status: 400 });
  }

  const session = await GetSession(sessionId, env);
  if (!session) {
    return json({ error: 'Session not found or expired' }, { status: 403 });
  }

  const newGroup = await createGroup(name, description || '', session.userId, env);
  if (!newGroup) {
    return json({ error: 'Failed to create group' }, { status: 500 });
  }

  return json({ message: 'Group created successfully', group: newGroup }, { status: 201 });
});

// Get all groups
router.get('/groups', withAdminCheck, async (request: Request, env: Env) => {
  const groups = await getAllGroups(env);
  return json({ groups });
});

// Get a specific group
router.get('/groups/:id', withAdminCheck, async (request: Request, env: Env) => {
  const id = (request as any).params.id;
  
  if (!id) {
    return json({ error: 'Group ID is required' }, { status: 400 });
  }

  const group = await getGroup(id, env);
  if (!group) {
    return json({ error: 'Group not found' }, { status: 404 });
  }

  return json({ group });
});

// Add a user to a group
router.post('/groups/:groupId/members', withAdminCheck, async (request: Request, env: Env) => {
  const groupId = (request as any).params.groupId;
  const body = await request.json() as { userId: string };
  const { userId } = body;

  if (!groupId || !userId) {
    return json({ error: 'Group ID and user ID are required' }, { status: 400 });
  }

  const success = await addUserToGroup(userId, groupId, env);
  if (!success) {
    return json({ error: 'Failed to add user to group' }, { status: 500 });
  }

  return json({ message: 'User added to group successfully' });
});

// Remove a user from a group
router.delete('/groups/:groupId/members/:userId', withAdminCheck, async (request: Request, env: Env) => {
  const groupId = (request as any).params.groupId;
  const userId = (request as any).params.userId;

  if (!groupId || !userId) {
    return json({ error: 'Group ID and user ID are required' }, { status: 400 });
  }

  const success = await removeUserFromGroup(userId, groupId, env);
  if (!success) {
    return json({ error: 'Failed to remove user from group' }, { status: 500 });
  }

  return json({ message: 'User removed from group successfully' });
});

// Delete a group
router.delete('/groups/:id', withAdminCheck, async (request: Request, env: Env) => {
  const id = (request as any).params.id;
  
  if (!id) {
    return json({ error: 'Group ID is required' }, { status: 400 });
  }

  const success = await deleteGroup(id, env);
  if (!success) {
    return json({ error: 'Failed to delete group' }, { status: 500 });
  }

  return json({ message: 'Group deleted successfully' });
});

// Delete a user
router.delete('/users/:id', withAdminCheck, async (request: Request, env: Env) => {
  const id = (request as any).params.id;
  
  if (!id) {
    return json({ error: 'User ID is required' }, { status: 400 });
  }

  const success = await deleteUser(id, env);
  if (!success) {
    return json({ error: 'Failed to delete user' }, { status: 500 });
  }

  return json({ message: 'User deleted successfully' });
});

// Update a user's name
router.put('/users/:id/update-name', withAdminCheck, async (request: Request, env: Env) => {
  const id = (request as any).params.id;
  const body = await request.json() as { name: string };
  const { name } = body;
  
  if (!id) {
    return json({ error: 'User ID is required' }, { status: 400 });
  }

  if (!name || name.trim() === '') {
    return json({ error: 'A valid name is required' }, { status: 400 });
  }

  const updatedUser = await updateUserName(id, name, env);
  if (!updatedUser) {
    return json({ error: 'User not found or update failed' }, { status: 404 });
  }

  return json({ 
    message: 'User name updated successfully', 
    user: updatedUser 
  });
});

// Send email to all users in a group
router.post('/groups/:groupId/send-email', withAdminCheck, async (request: Request, env: Env) => {
  const groupId = (request as any).params.groupId;
  const body = await request.json() as { subject: string; message: string };
  const { subject, message } = body;

  if (!groupId) {
    return json({ error: 'Group ID is required' }, { status: 400 });
  }

  if (!subject || !message) {
    return json({ error: 'Subject and message are required' }, { status: 400 });
  }

  // Get the group
  const group = await getGroup(groupId, env);
  if (!group) {
    return json({ error: 'Group not found' }, { status: 404 });
  }

  // Get all users in the group
  const users = await getAllUsers(env);
  const groupMembers = users.filter(user => 
    group.members.includes(user.id)
  );

  if (groupMembers.length === 0) {
    return json({ error: 'No users in this group' }, { status: 400 });
  }

  // Check if SES credentials are available
  if (!env.SESKey || !env.SESSecret) {
    return json({ error: 'Email service credentials not configured' }, { status: 500 });
  }

  // Send email to each user
  const results = [];
  for (const user of groupMembers) {
    try {
      const status = await sendEmail(
        user.email, 
        subject, 
        message, 
        env.SESKey, 
        env.SESSecret
      );
      results.push({ email: user.email, status });
    } catch (error) {
      results.push({ email: user.email, error: (error as Error).message });
    }
  }

  return json({ 
    message: `Email sent to ${results.length} users in the group`,
    results
  });
});

// Bulk create users
router.post('/bulk-create-users', withAdminCheck, async (request: Request, env: Env) => {
  const body = await request.json() as { users: { name: string; email: string; approved: boolean }[] };
  const { users } = body;

  if (!users || !Array.isArray(users) || users.length === 0) {
    return json({ error: 'Valid user entries are required' }, { status: 400 });
  }

  // Validate user entries
  const validUsers = users.filter(user => user.name && user.email);
  if (validUsers.length === 0) {
    return json({ error: 'No valid user entries provided' }, { status: 400 });
  }

  // Create users
  const createdUsers = [];
  const errors = [];

  for (const userEntry of validUsers) {
    try {
      // Create the user
      const newUser = await getOrCreateUser({
        name: userEntry.name,
        email: userEntry.email
      }, env);

      // Approve the user if requested
      if (userEntry.approved && !newUser.approved) {
        await approveUser(newUser.id, env);
        newUser.approved = true;
      }

      createdUsers.push(newUser);
    } catch (error) {
      errors.push({
        user: userEntry,
        error: (error as Error).message
      });
    }
  }

  return json({
    message: `Successfully created ${createdUsers.length} users`,
    users: createdUsers,
    errors: errors.length > 0 ? errors : undefined
  });
});

// Check if current user is an admin
router.get('/check', async (request: Request, env: Env) => {
  const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!sessionId) {
    return json({ error: 'Session ID is required' }, { status: 400 });
  }

  const session = await GetSession(sessionId, env);
  if (!session) {
    return json({ error: 'Session not found or expired' }, { status: 403 });
  }

  const userData = session.data as { email: string; name: string };
  const isUserAdmin = await isAdmin(userData.email, env);

  return json({ isAdmin: isUserAdmin });
});
