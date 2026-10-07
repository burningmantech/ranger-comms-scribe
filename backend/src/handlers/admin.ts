import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { 
  getAllUsers, 
  isAdmin, 
  createGroup,
  getAllGroups,
  getGroup,
  addUserToGroup,
  removeUserFromGroup,
  deleteGroup,
  getOrCreateUser,
  deleteUser,
  updateUserName,
  getUser
} from '../services/userService';
import { sendEmail } from '../utils/email';
import { User } from '../types';
import { GetSession, Env } from '../utils/sessionManager';
import { withAdminCheck } from '../authWrappers';
import { AccessChangeError, listPeople, personView, setAccess } from '../services/peopleService';
import { accessView, publicUser, rolesResponse } from '../services/access';
import { getObject, putObject, removeFromCache } from '../services/cacheService';
import { withAuth } from '../authWrappers';
import { getDevUserForRequest } from '../utils/devUsers';
import {
  FeedbackError,
  deleteFeedback,
  getFeedback,
  getFeedbackScreenshot,
  getFeedbackSettings,
  listFeedback,
  setFeedbackSettings,
  setPersonFeedback,
  updateFeedback,
} from '../services/feedbackService';

export const router = AutoRouter({ base: '/api/admin' });

// Get all users (without password hashes), with their access
router.get('/users', withAdminCheck, async (request: Request, env: Env) => {
  const users = await getAllUsers(env);
  return json({ users: users.map((u) => ({ ...publicUser(u), ...accessView(u, env) })) });
});

// People and their access (Admin → People)
router.get('/people', withAdminCheck, async (_request: Request, env: Env) => {
  const people = (await listPeople(env)).map((u) => personView(u, env))
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  return json({ people });
});

// Change one person's access: { isAdmin?, commsCadre?, councilRole? (one role, or null) }
router.put('/people/:id/access', withAdminCheck, async (request: Request, env: Env) => {
  const { id } = (request as any).params;
  const actor = (request as any).user as User;
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Send the access to change as JSON' }, { status: 400 });
  }
  if ('councilRoles' in body || 'approved' in body) {
    // A person holds one council role (`councilRole`), and anyone signed in can submit requests
    return json({ error: "Send councilRole (one role, or null); 'councilRoles' and 'approved' are no longer used" }, { status: 400 });
  }
  const patch: Record<string, unknown> = {};
  for (const key of ['isAdmin', 'commsCadre'] as const) {
    if (key in body) {
      if (typeof body[key] !== 'boolean') return json({ error: `${key} must be true or false` }, { status: 400 });
      patch[key] = body[key];
    }
  }
  if ('councilRole' in body) patch.councilRole = body.councilRole;
  try {
    const updated = await setAccess(decodeURIComponent(id), patch, actor, env);
    return json({ person: personView(updated, env) });
  } catch (err) {
    if (err instanceof AccessChangeError) return json({ error: err.message }, { status: err.status });
    throw err;
  }
});

// One person's feedback tab: { enabled: true | false | null } (null follows the global switch)
router.put('/people/:id/feedback', withAdminCheck, async (request: Request, env: Env) => {
  const { id } = (request as any).params;
  const body = await request.json().catch(() => null) as { enabled?: unknown } | null;
  if (!body || !(body.enabled === true || body.enabled === false || body.enabled === null)) {
    return json({ error: 'enabled must be true, false or null' }, { status: 400 });
  }
  try {
    const updated = await setPersonFeedback(decodeURIComponent(id), body.enabled, env);
    return json({ person: personView(updated, env) });
  } catch (err) {
    if (err instanceof FeedbackError) return json({ error: err.message }, { status: err.status });
    throw err;
  }
});

// Admin → Feedback: the global switch, and the feedback received (services/feedbackService.ts)
router.get('/feedback/settings', withAdminCheck, async (_request: Request, env: Env) => {
  return json({ settings: await getFeedbackSettings(env) });
});

router.put('/feedback/settings', withAdminCheck, async (request: Request, env: Env) => {
  const body = await request.json().catch(() => null) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== 'boolean') return json({ error: 'enabled must be true or false' }, { status: 400 });
  return json({ settings: await setFeedbackSettings(body.enabled, (request as any).user as User, env) });
});

router.get('/feedback', withAdminCheck, async (_request: Request, env: Env) => {
  return json({ feedback: await listFeedback(env) });
});

const FEEDBACK_ID = /^[0-9a-f-]{36}$/;

router.get('/feedback/:id', withAdminCheck, async (request: Request, env: Env) => {
  const { id } = (request as any).params;
  const report = FEEDBACK_ID.test(id) ? await getFeedback(id, env) : null;
  return report ? json({ feedback: report }) : json({ error: 'Feedback not found' }, { status: 404 });
});

router.get('/feedback/:id/screenshot', withAdminCheck, async (request: Request, env: Env) => {
  const { id } = (request as any).params;
  const image = FEEDBACK_ID.test(id) ? await getFeedbackScreenshot(id, env) : null;
  if (!image) return json({ error: 'No screenshot' }, { status: 404 });
  return new Response(image, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' } });
});

// Mark handled and keep notes: { handled?, notes? }
router.put('/feedback/:id', withAdminCheck, async (request: Request, env: Env) => {
  const { id } = (request as any).params;
  if (!FEEDBACK_ID.test(id)) return json({ error: 'Feedback not found' }, { status: 404 });
  try {
    const report = await updateFeedback(id, await request.json().catch(() => ({})), (request as any).user as User, env);
    return json({ feedback: report });
  } catch (err) {
    if (err instanceof FeedbackError) return json({ error: err.message }, { status: err.status });
    throw err;
  }
});

router.delete('/feedback/:id', withAdminCheck, async (request: Request, env: Env) => {
  const { id } = (request as any).params;
  if (!FEEDBACK_ID.test(id)) return json({ error: 'Feedback not found' }, { status: 404 });
  await deleteFeedback(id, env);
  return json({ success: true });
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

  // Send email to each user
  const results = [];
  for (const user of groupMembers) {
    try {
      const status = await sendEmail(user.email, subject, message, env);
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
  const body = await request.json() as { users: { name: string; email: string }[] };
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
      // Emails are stored lowercased (as sign-in finds them), so a pasted address can't make a duplicate
      const newUser = await getOrCreateUser({
        name: String(userEntry.name).trim(),
        email: String(userEntry.email).trim().toLowerCase()
      }, env);

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
    users: createdUsers.map((u) => ({ ...publicUser(u), ...accessView(u, env) })),
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

// The signed-in user's roles and review permissions (services/access.ts rolesResponse)
router.get('/user-roles', async (request: Request, env: Env) => {
  if (env.DEV_BYPASS_AUTH === 'true') {
    return json(rolesResponse(getDevUserForRequest(request), env));
  }

  const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!sessionId) {
    return json({ error: 'Session ID is required' }, { status: 400 });
  }

  const session = await GetSession(sessionId, env);
  if (!session) {
    return json({ error: 'Session not found or expired' }, { status: 403 });
  }

  const user = await getUser(session.userId, env);
  if (!user) {
    return json({ error: 'User not found' }, { status: 404 });
  }
  return json(rolesResponse(user, env));
});



