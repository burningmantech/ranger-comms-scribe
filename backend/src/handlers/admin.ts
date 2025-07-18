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
  updateUserName,
  getUser
} from '../services/userService';
import { 
  getAllRoles,
  getRole,
  updateRole,
  createRole,
  deleteRole,
  createGroupsForExistingRoles,
  Role
} from '../services/roleService';
import { sendEmail } from '../utils/email';
import { UserType, CouncilRole, CouncilMember } from '../types';
import { GetSession, Env } from '../utils/sessionManager';
import { withAdminCheck } from '../authWrappers';
import { getCouncilManagersForRole, addCouncilMember, removeCouncilMember } from '../services/councilManagerService';
import { getObject, putObject, removeFromCache } from '../services/cacheService';
import { withAuth } from '../authWrappers';

interface RequestWithParams extends Request {
  params: {
    roleName: string;
  };
}

export const router = AutoRouter({ base: '/api/admin' });

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

// Role management endpoints
router.get('/roles', withAdminCheck, async (request: Request, env: Env) => {
  try {
    const roles = await getAllRoles(env);
    return json({ roles });
  } catch (error) {
    return json({ error: 'Failed to fetch roles' }, { status: 500 });
  }
});

router.get('/roles/:roleName', async (request: Request, env: Env) => {
  try {
    const roleName = (request as any).params.roleName;
    console.log('🔍 Fetching role:', roleName);
    
    const role = getRole(roleName);
    if (!role) {
      console.log('❌ Role not found:', roleName);
      return json({ error: 'Role not found' }, { status: 404 });
    }
    
    console.log('✅ Role found:', role);
    return json({ role });
  } catch (error) {
    console.error('❌ Error fetching role:', error);
    return json({ error: 'Failed to fetch role' }, { status: 500 });
  }
});

router.put('/roles/:roleName', withAdminCheck, async (request: RequestWithParams, env: Env) => {
  const { roleName } = request.params;
  const updatedRole = await request.json() as Role;
  
  if (updatedRole.name !== roleName) {
    return json({ error: 'Role name mismatch' }, { status: 400 });
  }

  try {
    const role = await updateRole(roleName, updatedRole, env);
    return json({ role });
  } catch (error) {
    return json({ error: 'Failed to update role' }, { status: 500 });
  }
});

router.post('/roles', withAdminCheck, async (request: Request, env: Env) => {
  const newRole = await request.json() as Role;
  
  // Get the creator's ID from the session
  const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!sessionId) {
    return json({ error: 'Session ID is required' }, { status: 400 });
  }

  const session = await GetSession(sessionId, env);
  if (!session) {
    return json({ error: 'Session not found or expired' }, { status: 403 });
  }

  try {
    const role = await createRole(newRole, session.userId, env);
    return json({ role });
  } catch (error) {
    return json({ error: 'Failed to create role' }, { status: 500 });
  }
});

router.delete('/roles/:roleName', withAdminCheck, async (request: RequestWithParams, env: Env) => {
  const { roleName } = request.params;
  try {
    await deleteRole(roleName, env);
    return json({ message: 'Role deleted successfully' });
  } catch (error) {
    return json({ error: 'Failed to delete role' }, { status: 500 });
  }
});

router.post('/roles/sync-groups', withAdminCheck, async (request: Request, env: Env) => {
  // Get the creator's ID from the session
  const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!sessionId) {
    return json({ error: 'Session ID is required' }, { status: 400 });
  }

  const session = await GetSession(sessionId, env);
  if (!session) {
    return json({ error: 'Session not found or expired' }, { status: 403 });
  }

  try {
    const result = await createGroupsForExistingRoles(session.userId, env);
    return json({
      message: 'Groups synchronized with roles',
      created: result.created,
      existing: result.existing
    });
  } catch (error) {
    return json({ error: 'Failed to sync groups with roles' }, { status: 500 });
  }
});

// Add a new endpoint to get all roles for a user
router.get('/user-roles', async (request: Request, env: Env) => {
  const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!sessionId) {
    return json({ error: 'Session ID is required' }, { status: 400 });
  }

  const session = await GetSession(sessionId, env);
  if (!session) {
    return json({ error: 'Session not found or expired' }, { status: 403 });
  }

  try {
    const user = await getUser(session.userId, env);
    if (!user) {
      return json({ error: 'User not found' }, { status: 404 });
    }

    console.log('🔍 User data:', user);

    // Get all roles
    const allRoles = await getAllRoles(env);
    console.log('📋 All roles:', allRoles);
    
    // Get user's roles (including groups)
    const userRoles = new Set<string>();
    
    // Add roles from user type
    if (user.isAdmin) {
      userRoles.add('Admin');
    }
    if (user.userType === UserType.CouncilManager) {
      userRoles.add('CouncilManager');
    }
    if (user.userType === UserType.CommsCadre) {
      userRoles.add('CommsCadre');
    }

    // Add roles from groups
    if (user.groups) {
      const groups = await getAllGroups(env);
      for (const groupId of user.groups) {
        const group = groups.find(g => g.id === groupId);
        if (group && allRoles.some(role => role.name === group.name)) {
          userRoles.add(group.name);
        }
      }
    }

    console.log('👤 User roles:', Array.from(userRoles));

    // Get permissions from all roles
    const permissions = allRoles
      .filter(role => userRoles.has(role.name))
      .reduce((acc, role) => {
        console.log(`🔑 Processing role ${role.name} permissions:`, role.permissions);
        return {
          canEdit: acc.canEdit || role.permissions.canEdit,
          canApprove: acc.canApprove || role.permissions.canApprove,
          canCreateSuggestions: acc.canCreateSuggestions || role.permissions.canCreateSuggestions,
          canApproveSuggestions: acc.canApproveSuggestions || role.permissions.canApproveSuggestions,
          canReviewSuggestions: acc.canReviewSuggestions || role.permissions.canReviewSuggestions,
          canViewFilteredSubmissions: acc.canViewFilteredSubmissions || role.permissions.canViewFilteredSubmissions
        };
      }, {
        canEdit: false,
        canApprove: false,
        canCreateSuggestions: false,
        canApproveSuggestions: false,
        canReviewSuggestions: false,
        canViewFilteredSubmissions: false
      });

    // If user has Admin, CouncilManager, or CommsCadre role, grant all permissions
    if (userRoles.has('Admin') || userRoles.has('CouncilManager') || userRoles.has('CommsCadre')) {
      permissions.canEdit = true;
      permissions.canApprove = true;
      permissions.canCreateSuggestions = true;
      permissions.canApproveSuggestions = true;
      permissions.canReviewSuggestions = true;
      permissions.canViewFilteredSubmissions = true;
    }

    console.log('🔐 Final permissions:', permissions);

    return json({ 
      roles: Array.from(userRoles),
      permissions
    });
  } catch (error) {
    console.error('Error fetching user roles:', error);
    return json({ error: 'Failed to fetch user roles' }, { status: 500 });
  }
});

// Get all council managers
router.get('/council-managers', withAdminCheck, async (request: Request, env: Env) => {
  try {
    console.log('🔍 Fetching council managers...');
    
    // Get managers for each role
    const commsManagers = await getCouncilManagersForRole(CouncilRole.CommunicationsManager, env);
    const intakeManagers = await getCouncilManagersForRole(CouncilRole.IntakeManager, env);
    const logisticsManagers = await getCouncilManagersForRole(CouncilRole.LogisticsManager, env);
    const operationsManagers = await getCouncilManagersForRole(CouncilRole.OperationsManager, env);
    const personnelManagers = await getCouncilManagersForRole(CouncilRole.PersonnelManager, env);
    const departmentManagers = await getCouncilManagersForRole(CouncilRole.DepartmentManager, env);
    const deputyManagers = await getCouncilManagersForRole(CouncilRole.DeputyDepartmentManager, env);

    console.log('📊 Role breakdown:');
    console.log('  CommunicationsManager:', commsManagers.length);
    console.log('  IntakeManager:', intakeManagers.length);
    console.log('  LogisticsManager:', logisticsManagers.length);
    console.log('  OperationsManager:', operationsManagers.length);
    console.log('  PersonnelManager:', personnelManagers.length);
    console.log('  DepartmentManager:', departmentManagers.length);
    console.log('  DeputyDepartmentManager:', deputyManagers.length);

    // Combine all managers
    const allManagers = [
      ...commsManagers,
      ...intakeManagers,
      ...logisticsManagers,
      ...operationsManagers,
      ...personnelManagers,
      ...departmentManagers,
      ...deputyManagers
    ];

    console.log('🔍 Backend council managers response:', allManagers);
    console.log('🔍 Backend council managers count:', allManagers.length);

    return json(allManagers);
  } catch (error) {
    console.error('Error fetching council managers:', error);
    return json({ error: 'Error fetching council managers' }, { status: 500 });
  }
});

// Update council managers
router.put('/council-managers', withAdminCheck, async (request: Request, env: Env) => {
  try {
    const body = await request.json() as { email: string; role: CouncilRole; action: 'add' | 'remove' };
    const { email, role, action } = body;

    console.log('🔄 Council manager update request:', { email, role, action });

    if (!email || !role || !action) {
      return json({ error: 'Email, role, and action are required' }, { status: 400 });
    }

    if (action === 'add') {
      console.log('➕ Adding council member...');
      const newMember = await addCouncilMember(email, role, env);
      if (!newMember) {
        console.log('❌ Failed to add council member');
        return json({ error: 'Failed to add council member' }, { status: 500 });
      }
      console.log('✅ Council member added successfully');
      return json({ message: 'Council member added successfully', member: newMember });
    } else {
      console.log('➖ Removing council member...');
      const success = await removeCouncilMember(email, role, env);
      if (!success) {
        console.log('❌ Failed to remove council member');
        return json({ error: 'Failed to remove council member' }, { status: 500 });
      }
      console.log('✅ Council member removed successfully');
      return json({ message: 'Council member removed successfully' });
    }
  } catch (error) {
    console.error('Error updating council manager:', error);
    return json({ error: 'Failed to update council manager' }, { status: 500 });
  }
});


