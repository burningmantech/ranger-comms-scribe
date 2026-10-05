import { Env } from '../utils/sessionManager';
import { getObjectStrict, putObject } from './cacheService';
import { createGroup, deleteGroup, getAllGroups } from './userService';
import { Group } from '../types';

export interface Role {
  name: string;
  description: string;
  permissions: {
    canEdit: boolean;
    canApprove: boolean;
    canCreateSuggestions: boolean;
    canApproveSuggestions: boolean;
    canReviewSuggestions: boolean;
    canViewFilteredSubmissions: boolean;
  };
}

export const DEFAULT_ROLES: Role[] = [
  {
    name: 'CommsCadre',
    description: 'Communications Cadre member with content management permissions',
    permissions: {
      canEdit: true,
      canApprove: true,
      canCreateSuggestions: true,
      canApproveSuggestions: true,
      canReviewSuggestions: true,
      canViewFilteredSubmissions: true
    }
  },
  {
    name: 'CouncilManager',
    description: 'Council Manager with content management permissions',
    permissions: {
      canEdit: true,
      canApprove: true,
      canCreateSuggestions: true,
      canApproveSuggestions: true,
      canReviewSuggestions: true,
      canViewFilteredSubmissions: true
    }
  },
  {
    name: 'Admin',
    description: 'System administrator with full permissions',
    permissions: {
      canEdit: true,
      canApprove: true,
      canCreateSuggestions: true,
      canApproveSuggestions: true,
      canReviewSuggestions: true,
      canViewFilteredSubmissions: true
    }
  },
  {
    name: 'Public',
    description: 'Public user with limited permissions',
    permissions: {
      canEdit: false,
      canApprove: false,
      canCreateSuggestions: false,
      canApproveSuggestions: false,
      canReviewSuggestions: false,
      canViewFilteredSubmissions: false
    }
  }
];

const ROLES_CACHE_KEY = 'roles';

/**
 * The stored roles, initializing them (and their groups) when none exist.
 *
 * The read is strict: a store error is thrown rather than treated as "no roles",
 * which would overwrite the stored list with DEFAULT_ROLES. For the same reason the
 * defaults are never returned after a failed read: updateRole, createRole and
 * deleteRole write back whatever this returns.
 */
export const getAllRoles = async (env: Env): Promise<Role[]> => {
  const roles = await getObjectStrict<Role[]>(ROLES_CACHE_KEY, env);
  try {
    if (!roles || roles.length === 0) {
      console.log('Initializing default roles...');
      // Initialize with default roles if none exist
      await putObject(ROLES_CACHE_KEY, DEFAULT_ROLES, env, {
        contentType: 'application/json'
      });

      // Create corresponding groups for default roles
      const groups = await getAllGroups(env);
      const existingGroupNames = new Set(groups.map(group => group.name));

      // Create groups for any default roles that don't have corresponding groups
      for (const role of DEFAULT_ROLES) {
        if (!existingGroupNames.has(role.name)) {
          console.log(`Creating group for role: ${role.name}`);
          await createGroup(
            role.name,
            `Group for role: ${role.description}`,
            'admin@burningman.org', // Use a default admin account for system-created groups
            env
          );
        }
      }

      return DEFAULT_ROLES;
    }
    console.log('Retrieved roles:', roles);
    return roles;
  } catch (error) {
    console.error('Error in getAllRoles:', error);
    // Initializing failed. No roles were stored (the read above found none), so
    // the defaults are still the right answer.
    return DEFAULT_ROLES;
  }
};

export const getRoles = (): Role[] => {
  return DEFAULT_ROLES;
};

export const getRole = (roleName: string): Role | null => {
  console.log('🔍 Getting role:', roleName);
  const roles = getRoles();
  console.log('📋 Available roles:', roles.map((r: Role) => r.name));
  
  // Convert both the input role name and the role names to lowercase for comparison
  const role = roles.find((r: Role) => r.name.toLowerCase() === roleName.toLowerCase());
  console.log('✅ Found role:', role);
  return role || null;
};

export const updateRole = async (roleName: string, updatedRole: Role, env: Env): Promise<Role> => {
  const roles = await getAllRoles(env);
  const roleIndex = roles.findIndex(role => role.name === roleName);
  
  if (roleIndex === -1) {
    throw new Error('Role not found');
  }

  roles[roleIndex] = updatedRole;
  await putObject(ROLES_CACHE_KEY, roles, env);
  
  return updatedRole;
};

export const createRole = async (newRole: Role, creator: string, env: Env): Promise<Role> => {
  const roles = await getAllRoles(env);
  
  if (roles.some(role => role.name === newRole.name)) {
    throw new Error('Role already exists');
  }

  // Create a corresponding group for the role
  const group = await createGroup(
    newRole.name,
    `Group for role: ${newRole.description}`,
    creator, // Use the authenticated admin user as creator
    env
  );

  if (!group) {
    throw new Error('Failed to create corresponding group for role');
  }

  roles.push(newRole);
  await putObject(ROLES_CACHE_KEY, roles, env);
  
  return newRole;
};

export const deleteRole = async (roleName: string, env: Env): Promise<void> => {
  const roles = await getAllRoles(env);
  const roleToDelete = roles.find(role => role.name === roleName);
  
  if (!roleToDelete) {
    throw new Error('Role not found');
  }

  // Delete the corresponding group for the role
  const groups = await getAllGroups(env);
  const correspondingGroup = groups.find((group: Group) => group.name === roleName);
  
  if (correspondingGroup) {
    const success = await deleteGroup(correspondingGroup.id, env);
    if (!success) {
      throw new Error('Failed to delete corresponding group for role');
    }
  }

  const filteredRoles = roles.filter(role => role.name !== roleName);
  await putObject(ROLES_CACHE_KEY, filteredRoles, env);
};

export const createGroupsForExistingRoles = async (creator: string, env: Env): Promise<{ created: string[], existing: string[] }> => {
  const roles = await getAllRoles(env);
  const groups = await getAllGroups(env);
  const existingGroupNames = new Set(groups.map(group => group.name));
  
  const created: string[] = [];
  const existing: string[] = [];

  for (const role of roles) {
    if (existingGroupNames.has(role.name)) {
      existing.push(role.name);
      continue;
    }

    const group = await createGroup(
      role.name,
      `Group for role: ${role.description}`,
      creator,
      env
    );

    if (group) {
      created.push(role.name);
    }
  }

  return { created, existing };
}; 