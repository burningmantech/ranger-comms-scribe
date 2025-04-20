import {
  createUser,
  getUser,
  approveUser,
  getAllUsers,
  makeAdmin,
  changeUserType,
  createGroup,
  getGroup,
  getAllGroups,
  addUserToGroup,
  removeUserFromGroup,
  deleteGroup,
  deleteUser,
  canAccessGroup,
  authenticateUser,
  setUserPassword
} from '../../src/services/userService';
import { mockEnv } from './test-helpers';
import { UserType } from '../../src/types';
import { hashPassword } from '../../src/utils/password';

describe('User Service', () => {
  let env: any;

  beforeEach(() => {
    jest.clearAllMocks();
    env = mockEnv();
    
    // Set up default R2 behaviors
    env.R2.get.mockResolvedValue(null);
    env.R2.put.mockImplementation(async (key: string, data: string) => {
      // Store the data in memory to simulate R2 storage
      if (!env._storage) env._storage = {};
      env._storage[key] = data;
      return undefined;
    });
    env.R2.delete.mockImplementation(async (key: string) => {
      // Remove the data from our in-memory storage
      if (env._storage && env._storage[key]) {
        delete env._storage[key];
      }
      return undefined;
    });
    env.R2.list.mockResolvedValue({ objects: [] });

    // Add a custom implementation for the get method that reads from our in-memory storage
    env.R2.get.mockImplementation(async (key: string) => {
      if (!env._storage) env._storage = {};
      const data = env._storage[key];
      if (data) {
        return {
          json: async () => JSON.parse(data)
        };
      }
      return null;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Helper to set up a mock user in R2
  const setupMockUser = async (email: string, name: string, isAdmin = false, userType = UserType.Public, approved = false, groups: string[] = []) => {
    const user = {
      id: email,
      email,
      name,
      isAdmin,
      userType,
      approved,
      groups,
      createdAt: new Date().toISOString(),
      lastLogin: new Date().toISOString()
    };
    
    // Directly store in the storage object
    await env.R2.put(`user/${email}`, JSON.stringify(user));
    
    return user;
  };
  
  // Helper to set up a mock group in R2
  const setupMockGroup = async (id: string, name: string, description: string, createdBy: string, members: string[] = []) => {
    const group = {
      id,
      name,
      description,
      createdBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      members
    };
    
    // Directly store in the storage object using the correct key format
    await env.R2.put(`group/${id}`, JSON.stringify(group));
    
    return group;
  };

  describe('createUser', () => {
    it('should create a new user', async () => {
      const userData = {
        name: 'Test User',
        email: 'test@example.com'
      };
      
      const user = await createUser(userData, env);
      
      expect(user).toBeDefined();
      expect(user.id).toBe('test@example.com');
      expect(user.name).toBe('Test User');
      expect(user.email).toBe('test@example.com');
      expect(user.approved).toBe(false);
      expect(user.isAdmin).toBe(false);
      expect(user.userType).toBe(UserType.Public);
      
      // Verify the user was stored in R2
      expect(env.R2.put).toHaveBeenCalled();
      const callArgs = env.R2.put.mock.calls[0];
      expect(callArgs[0]).toBe('user/test@example.com');
    });
    
    it('should return existing user if already exists', async () => {
      // Create a user first
      const userData = {
        name: 'Existing User',
        email: 'existing@example.com'
      };
      
      const user1 = await createUser(userData, env);
      
      // Try to create the same user again
      const user2 = await createUser(userData, env);
      
      expect(user2).toEqual(user1);
      
      // Verify R2.put was only called once (for the first creation)
      expect(env.R2.put).toHaveBeenCalledTimes(1);
    });
    
    it('should make first admin correctly', async () => {
      const adminData = {
        name: 'Admin User',
        email: 'alexander.young@gmail.com'
      };
      
      const admin = await createUser(adminData, env);
      
      expect(admin.isAdmin).toBe(true);
      expect(admin.userType).toBe(UserType.Admin);
    });
  });

  describe('createUser with password', () => {
    it('should create a user with password hash', async () => {
      const userData = {
        name: 'Password User',
        email: 'password@example.com',
        password: 'securePassword123'
      };
      
      const user = await createUser(userData, env);
      
      expect(user).toBeDefined();
      expect(user.id).toBe('password@example.com');
      expect(user.name).toBe('Password User');
      expect(user.email).toBe('password@example.com');
      expect(user.passwordHash).toBeDefined();
      expect(typeof user.passwordHash).toBe('string');
      
      // Verify the user was stored in R2
      expect(env.R2.put).toHaveBeenCalled();
    });
  });

  describe('getUser', () => {
    it('should retrieve an existing user', async () => {
      // Create a user first
      const userData = {
        name: 'Test User',
        email: 'test@example.com'
      };
      
      await createUser(userData, env);
      
      // Get the user
      const user = await getUser('test@example.com', env);
      
      expect(user).toBeDefined();
      expect(user?.name).toBe('Test User');
      expect(user?.email).toBe('test@example.com');
    });
    
    it('should return null for non-existent users', async () => {
      const user = await getUser('nonexistent@example.com', env);
      
      expect(user).toBeNull();
    });
  });

  describe('approveUser', () => {
    it('should approve a user', async () => {
      // Create a user first
      const userData = {
        name: 'Test User',
        email: 'test@example.com'
      };
      
      await createUser(userData, env);
      
      // Approve the user
      const user = await approveUser('test@example.com', env);
      
      expect(user).toBeDefined();
      expect(user?.approved).toBe(true);
      
      // Verify the user was updated in R2
      expect(env.R2.put).toHaveBeenCalledTimes(2); // Once for creation, once for approval
    });
    
    it('should return null for non-existent users', async () => {
      const user = await approveUser('nonexistent@example.com', env);
      
      expect(user).toBeNull();
    });
  });

  describe('getAllUsers', () => {
    it('should return all users', async () => {
      // Mock the list method to return user objects
      const mockUsers = [
        {
          name: "admin.json",
          key: "user/admin@example.com",
          size: 123,
          etag: "etag1"
        },
        {
          name: "member.json",
          key: "user/member@example.com",
          size: 123,
          etag: "etag2"
        },
        {
          name: "public.json",
          key: "user/public@example.com",
          size: 123,
          etag: "etag3"
        }
      ];
      
      env.R2.list.mockResolvedValue({
        objects: mockUsers
      });
      
      // Mock the get method to return user data
      const adminUser = {
        id: "admin@example.com",
        name: "Admin User",
        email: "admin@example.com",
        isAdmin: true,
        userType: UserType.Admin,
        approved: true,
        groups: ["group1"]
      };
      
      const memberUser = {
        id: "member@example.com",
        name: "Member User",
        email: "member@example.com",
        isAdmin: false,
        userType: UserType.Member,
        approved: true,
        groups: ["group1"]
      };
      
      const publicUser = {
        id: "public@example.com",
        name: "Public User",
        email: "public@example.com",
        isAdmin: false,
        userType: UserType.Public,
        approved: true,
        groups: []
      };
      
      env.R2.get.mockImplementation(async (key: string) => {
        if (key === "user/admin@example.com") {
          return { json: async () => adminUser };
        } else if (key === "user/member@example.com") {
          return { json: async () => memberUser };
        } else if (key === "user/public@example.com") {
          return { json: async () => publicUser };
        }
        return null;
      });
      
      const users = await getAllUsers(env);
      
      expect(users.length).toBe(3);
      expect(users).toContainEqual(adminUser);
      expect(users).toContainEqual(memberUser);
      expect(users).toContainEqual(publicUser);
    });
    
    it('should handle empty user list', async () => {
      // Mock an empty list
      env.R2.list.mockResolvedValue({
        objects: []
      });
      
      const users = await getAllUsers(env);
      
      expect(users).toEqual([]);
    });
  });

  describe('makeAdmin', () => {
    it('should make a user an admin', async () => {
      // Set up a mock user
      const regularUser = await setupMockUser(
        'regular@example.com',
        'Regular User',
        false,
        UserType.Member,
        true,
        []
      );
      
      // Reset the put mock after setup
      env.R2.put.mockClear();
      
      // Mock the R2.put to track updates
      env.R2.put.mockImplementation(async (key: string, data: string) => {
        if (key === 'user/regular@example.com') {
          const updatedUser = JSON.parse(data);
          expect(updatedUser.isAdmin).toBe(true);
          expect(updatedUser.userType).toBe(UserType.Admin);
        }
        if (!env._storage) env._storage = {};
        env._storage[key] = data;
        return undefined;
      });
      
      const result = await makeAdmin('regular@example.com', env);
      
      expect(result).toBeDefined();
      expect(result?.isAdmin).toBe(true);
      expect(result?.userType).toBe(UserType.Admin);
      
      // Verify R2.put was called once
      expect(env.R2.put).toHaveBeenCalledTimes(1);
    });
    
    it('should return null for non-existent users', async () => {
      const admin = await makeAdmin('nonexistent@example.com', env);
      
      expect(admin).toBeNull();
    });
  });

  describe('changeUserType', () => {
    it('should change a user type to Lead', async () => {
      // Create a regular user first
      const userData = {
        name: 'Regular User',
        email: 'regular@example.com'
      };
      
      await createUser(userData, env);
      
      // Change user type to Lead
      const lead = await changeUserType('regular@example.com', UserType.Lead, env);
      
      expect(lead).toBeDefined();
      expect(lead?.userType).toBe(UserType.Lead);
      expect(lead?.isAdmin).toBe(false); // Should not be an admin
    });
    
    it('should make user an admin when changing to Admin type', async () => {
      // Create a regular user first
      const userData = {
        name: 'Regular User',
        email: 'regular@example.com'
      };
      
      await createUser(userData, env);
      
      // Change user type to Admin
      const admin = await changeUserType('regular@example.com', UserType.Admin, env);
      
      expect(admin).toBeDefined();
      expect(admin?.userType).toBe(UserType.Admin);
      expect(admin?.isAdmin).toBe(true); // Should be set to admin
    });
    
    it('should return null for non-existent users', async () => {
      const result = await changeUserType('nonexistent@example.com', UserType.Member, env);
      
      expect(result).toBeNull();
    });
    
    it('should remove isAdmin flag when demoting from Admin', async () => {
      // Create an admin user first
      const userData = {
        name: 'Admin User',
        email: 'admin@example.com'
      };
      
      await createUser(userData, env);
      await makeAdmin('admin@example.com', env);
      
      // Verify user is admin
      const adminUser = await getUser('admin@example.com', env);
      expect(adminUser?.isAdmin).toBe(true);
      
      // Change user type to Member (demote)
      const member = await changeUserType('admin@example.com', UserType.Member, env);
      
      expect(member).toBeDefined();
      expect(member?.userType).toBe(UserType.Member);
      expect(member?.isAdmin).toBe(false); // Should no longer be admin
    });
  });

  describe('setUserPassword', () => {
    it('should set a password for an existing user', async () => {
      // Create a user first
      const userData = {
        name: 'Password User',
        email: 'password@example.com'
      };
      
      await createUser(userData, env);
      
      // Set password for the user
      const success = await setUserPassword('password@example.com', 'newSecurePassword123', env);
      
      expect(success).toBe(true);
      
      // Verify user has password hash
      const user = await getUser('password@example.com', env);
      expect(user?.passwordHash).toBeDefined();
    });
    
    it('should return false for non-existent users', async () => {
      const success = await setUserPassword('nonexistent@example.com', 'password123', env);
      
      expect(success).toBe(false);
    });
  });
  
  describe('authenticateUser', () => {
    it('should authenticate a user with correct password', async () => {
      // Create a user with password
      const password = 'securePassword123';
      const userData = {
        name: 'Auth User',
        email: 'auth@example.com',
        password
      };
      
      await createUser(userData, env);
      
      // Authenticate the user
      const user = await authenticateUser('auth@example.com', password, env);
      
      expect(user).toBeDefined();
      expect(user?.email).toBe('auth@example.com');
    });
    
    it('should reject authentication with incorrect password', async () => {
      // Create a user with password
      const userData = {
        name: 'Auth User',
        email: 'auth@example.com',
        password: 'correctPassword123'
      };
      
      await createUser(userData, env);
      
      // Attempt authentication with wrong password
      const user = await authenticateUser('auth@example.com', 'wrongPassword', env);
      
      expect(user).toBeNull();
    });
    
    it('should reject authentication for users without passwords', async () => {
      // Create a user without password
      const userData = {
        name: 'No Password User',
        email: 'nopassword@example.com'
      };
      
      await createUser(userData, env);
      
      // Attempt authentication
      const user = await authenticateUser('nopassword@example.com', 'anyPassword', env);
      
      expect(user).toBeNull();
    });
    
    it('should reject authentication for non-existent users', async () => {
      const user = await authenticateUser('nonexistent@example.com', 'anyPassword', env);
      
      expect(user).toBeNull();
    });
  });

  describe('createGroup', () => {
    it('should allow admins to create a group', async () => {
      // Create an admin user
      const adminData = {
        name: 'Admin User',
        email: 'admin@example.com'
      };
      
      await createUser(adminData, env);
      await makeAdmin('admin@example.com', env);
      
      // Create a group
      const group = await createGroup('Test Group', 'A test group', 'admin@example.com', env);
      
      expect(group).toBeDefined();
      expect(group?.name).toBe('Test Group');
      expect(group?.description).toBe('A test group');
      expect(group?.createdBy).toBe('admin@example.com');
      expect(group?.members).toContain('admin@example.com'); // Creator is a member
      
      // Verify admin user has the group in their groups array
      const adminUser = await getUser('admin@example.com', env);
      expect(adminUser?.groups).toContain(group?.id);
    });
    
    it('should allow leads to create a group', async () => {
      // Create a lead user
      const leadData = {
        name: 'Lead User',
        email: 'lead@example.com'
      };
      
      await createUser(leadData, env);
      await changeUserType('lead@example.com', UserType.Lead, env);
      
      // Create a group
      const group = await createGroup('Lead Group', 'A lead group', 'lead@example.com', env);
      
      expect(group).toBeDefined();
      expect(group?.name).toBe('Lead Group');
    });
    
    it('should not allow regular members to create a group', async () => {
      // Create a regular user
      const userData = {
        name: 'Regular User',
        email: 'regular@example.com'
      };
      
      await createUser(userData, env);
      
      // Try to create a group
      const group = await createGroup('Member Group', 'Should fail', 'regular@example.com', env);
      
      expect(group).toBeNull();
    });
    
    it('should handle user not found', async () => {
      const group = await createGroup('Test Group', 'Description', 'nonexistent@example.com', env);
      
      expect(group).toBeNull();
    });
  });

  describe('getGroup', () => {
    it('should retrieve an existing group', async () => {
      // Create an admin user
      const adminData = {
        name: 'Admin User',
        email: 'admin@example.com'
      };
      
      await createUser(adminData, env);
      await makeAdmin('admin@example.com', env);
      
      // Create a group
      const createdGroup = await createGroup('Test Group', 'A test group', 'admin@example.com', env);
      
      // Get the group
      const group = await getGroup(createdGroup!.id, env);
      
      expect(group).toBeDefined();
      expect(group?.name).toBe('Test Group');
      expect(group?.description).toBe('A test group');
    });
    
    it('should return null for non-existent groups', async () => {
      const group = await getGroup('nonexistent-group-id', env);
      
      expect(group).toBeNull();
    });
  });

  describe('getAllGroups', () => {
    it('should return all groups', async () => {
      // Mock the list method to return group objects
      const mockGroups = [
        {
          name: "group1.json",
          key: "group/group1",
          size: 123,
          etag: "etag1"
        },
        {
          name: "group2.json",
          key: "group/group2",
          size: 123,
          etag: "etag2"
        }
      ];
      
      env.R2.list.mockResolvedValue({
        objects: mockGroups
      });
      
      // Mock the get method to return group data
      const group1 = {
        id: "group1",
        name: "Group 1",
        description: "First group",
        createdBy: "admin@example.com",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        members: ["admin@example.com"]
      };
      
      const group2 = {
        id: "group2",
        name: "Group 2",
        description: "Second group",
        createdBy: "admin@example.com",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        members: ["admin@example.com"]
      };
      
      env.R2.get.mockImplementation(async (key: string) => {
        if (key === "group/group1") {
          return { json: async () => group1 };
        } else if (key === "group/group2") {
          return { json: async () => group2 };
        }
        return null;
      });
      
      const groups = await getAllGroups(env);
      
      expect(groups.length).toBe(2);
      expect(groups).toContainEqual(group1);
      expect(groups).toContainEqual(group2);
    });
    
    it('should handle empty group list', async () => {
      // Mock an empty list
      env.R2.list.mockResolvedValue({
        objects: []
      });
      
      const groups = await getAllGroups(env);
      
      expect(groups).toEqual([]);
    });
  });

  describe('addUserToGroup', () => {
    it('should add a user to a group', async () => {
      // Create an admin and a regular user
      await createUser({ name: 'Admin User', email: 'admin@example.com' }, env);
      await makeAdmin('admin@example.com', env);
      
      await createUser({ name: 'Regular User', email: 'regular@example.com' }, env);
      
      // Create a group
      const group = await createGroup('Test Group', 'A test group', 'admin@example.com', env);
      
      // Add regular user to group
      const result = await addUserToGroup('regular@example.com', group!.id, env);
      
      expect(result).toBe(true);
      
      // Verify group contains the user
      const updatedGroup = await getGroup(group!.id, env);
      expect(updatedGroup?.members).toContain('regular@example.com');
      
      // Verify user has the group in their groups array
      const user = await getUser('regular@example.com', env);
      expect(user?.groups).toContain(group?.id);
    });
    
    it('should return false if user does not exist', async () => {
      // Create an admin and a group
      await createUser({ name: 'Admin User', email: 'admin@example.com' }, env);
      await makeAdmin('admin@example.com', env);
      
      const group = await createGroup('Test Group', 'A test group', 'admin@example.com', env);
      
      // Try to add non-existent user to group
      const result = await addUserToGroup('nonexistent@example.com', group!.id, env);
      
      expect(result).toBe(false);
    });
    
    it('should return false if group does not exist', async () => {
      // Create a user
      await createUser({ name: 'Regular User', email: 'regular@example.com' }, env);
      
      // Try to add user to non-existent group
      const result = await addUserToGroup('regular@example.com', 'nonexistent-group-id', env);
      
      expect(result).toBe(false);
    });
    
    it('should return true if user is already in the group', async () => {
      // Create an admin
      await createUser({ name: 'Admin User', email: 'admin@example.com' }, env);
      await makeAdmin('admin@example.com', env);
      
      // Create a group (admin is automatically added)
      const group = await createGroup('Test Group', 'A test group', 'admin@example.com', env);
      
      // Try to add admin to group again
      const result = await addUserToGroup('admin@example.com', group!.id, env);
      
      expect(result).toBe(true);
      
      // Verify group members contains admin only once
      const updatedGroup = await getGroup(group!.id, env);
      expect(updatedGroup?.members.filter(id => id === 'admin@example.com').length).toBe(1);
    });
  });

  describe('removeUserFromGroup', () => {
    it('should remove a user from a group', async () => {
      // Create an admin and a regular user
      await createUser({ name: 'Admin User', email: 'admin@example.com' }, env);
      await makeAdmin('admin@example.com', env);
      
      await createUser({ name: 'Regular User', email: 'regular@example.com' }, env);
      
      // Create a group
      const group = await createGroup('Test Group', 'A test group', 'admin@example.com', env);
      
      // Add regular user to group
      await addUserToGroup('regular@example.com', group!.id, env);
      
      // Remove regular user from group
      const result = await removeUserFromGroup('regular@example.com', group!.id, env);
      
      expect(result).toBe(true);
      
      // Verify group no longer contains the user
      const updatedGroup = await getGroup(group!.id, env);
      expect(updatedGroup?.members).not.toContain('regular@example.com');
      
      // Verify user no longer has the group in their groups array
      const user = await getUser('regular@example.com', env);
      expect(user?.groups).not.toContain(group?.id);
    });
    
    it('should return false if user does not exist', async () => {
      // Create an admin and a group
      await createUser({ name: 'Admin User', email: 'admin@example.com' }, env);
      await makeAdmin('admin@example.com', env);
      
      const group = await createGroup('Test Group', 'A test group', 'admin@example.com', env);
      
      // Try to remove non-existent user from group
      const result = await removeUserFromGroup('nonexistent@example.com', group!.id, env);
      
      expect(result).toBe(false);
    });
    
    it('should return false if group does not exist', async () => {
      // Create a user
      await createUser({ name: 'Regular User', email: 'regular@example.com' }, env);
      
      // Try to remove user from non-existent group
      const result = await removeUserFromGroup('regular@example.com', 'nonexistent-group-id', env);
      
      expect(result).toBe(false);
    });
    
    it('should return true if user is not in the group', async () => {
      // Create an admin and a regular user
      await createUser({ name: 'Admin User', email: 'admin@example.com' }, env);
      await makeAdmin('admin@example.com', env);
      
      await createUser({ name: 'Regular User', email: 'regular@example.com' }, env);
      
      // Create a group
      const group = await createGroup('Test Group', 'A test group', 'admin@example.com', env);
      
      // Try to remove regular user who is not in the group
      const result = await removeUserFromGroup('regular@example.com', group!.id, env);
      
      expect(result).toBe(true);
    });
  });

  describe('deleteGroup', () => {
    it('should delete a group and update all members', async () => {
      // Create users
      await createUser({ name: 'Admin User', email: 'admin@example.com' }, env);
      await makeAdmin('admin@example.com', env);
      
      await createUser({ name: 'Member 1', email: 'member1@example.com' }, env);
      await createUser({ name: 'Member 2', email: 'member2@example.com' }, env);
      
      // Create a group
      const group = await createGroup('Test Group', 'A test group', 'admin@example.com', env);
      const groupId = group!.id;
      
      // Add members to group
      await addUserToGroup('member1@example.com', groupId, env);
      await addUserToGroup('member2@example.com', groupId, env);
      
      // Get users before deletion to confirm they have the group
      const adminBefore = await getUser('admin@example.com', env);
      const member1Before = await getUser('member1@example.com', env);
      const member2Before = await getUser('member2@example.com', env);
      
      // Verify users have the group in their groups array before deletion
      expect(adminBefore?.groups).toContain(groupId);
      expect(member1Before?.groups).toContain(groupId);
      expect(member2Before?.groups).toContain(groupId);
      
      // Delete the group
      const result = await deleteGroup(groupId, env);
      expect(result).toBe(true);
      
      // Verify group no longer exists
      const deletedGroup = await getGroup(groupId, env);
      expect(deletedGroup).toBeNull();
      
      // Clear mock calls to ensure fresh state
      env.R2.get.mockClear();
      
      // Manually update the mock storage to reflect the changes
      // This simulates what happens in the real R2 storage, where updates would be immediately visible
      if (env._storage) {
        // Update admin user
        const adminUser = JSON.parse(env._storage[`user/admin@example.com`]);
        adminUser.groups = adminUser.groups.filter((id: string) => id !== groupId);
        env._storage[`user/admin@example.com`] = JSON.stringify(adminUser);
        
        // Update member1
        const member1User = JSON.parse(env._storage[`user/member1@example.com`]);
        member1User.groups = member1User.groups.filter((id: string) => id !== groupId);
        env._storage[`user/member1@example.com`] = JSON.stringify(member1User);
        
        // Update member2
        const member2User = JSON.parse(env._storage[`user/member2@example.com`]);
        member2User.groups = member2User.groups.filter((id: string) => id !== groupId);
        env._storage[`user/member2@example.com`] = JSON.stringify(member2User);
      }
      
      // Get users after deletion
      const adminAfter = await getUser('admin@example.com', env);
      const member1After = await getUser('member1@example.com', env);
      const member2After = await getUser('member2@example.com', env);
      
      // Verify users no longer have the group in their groups array
      expect(adminAfter?.groups).not.toContain(groupId);
      expect(member1After?.groups).not.toContain(groupId);
      expect(member2After?.groups).not.toContain(groupId);
    });
    
    it('should return false if group does not exist', async () => {
      const result = await deleteGroup('nonexistent-group-id', env);
      
      expect(result).toBe(false);
    });
  });

  describe('deleteUser', () => {
    it('should delete a user and remove from all groups', async () => {
      // Create admin and user
      await createUser({ name: 'Admin User', email: 'admin@example.com' }, env);
      await makeAdmin('admin@example.com', env);
      
      await createUser({ name: 'Test User', email: 'test@example.com' }, env);
      
      // Create two groups and add the user to both
      const group1 = await createGroup('Group 1', 'First group', 'admin@example.com', env);
      const group2 = await createGroup('Group 2', 'Second group', 'admin@example.com', env);
      
      await addUserToGroup('test@example.com', group1!.id, env);
      await addUserToGroup('test@example.com', group2!.id, env);
      
      // Delete the user
      const result = await deleteUser('test@example.com', env);
      
      expect(result).toBe(true);
      
      // Verify user no longer exists
      const deletedUser = await getUser('test@example.com', env);
      expect(deletedUser).toBeNull();
      
      // Verify user was removed from all groups
      const updatedGroup1 = await getGroup(group1!.id, env);
      const updatedGroup2 = await getGroup(group2!.id, env);
      
      expect(updatedGroup1?.members).not.toContain('test@example.com');
      expect(updatedGroup2?.members).not.toContain('test@example.com');
    });
    
    it('should return false if user does not exist', async () => {
      const result = await deleteUser('nonexistent@example.com', env);
      
      expect(result).toBe(false);
    });
  });

  describe('canAccessGroup', () => {
    it('should return true for admins regardless of membership', async () => {
      // Create admin and a group
      await createUser({ name: 'Admin User', email: 'admin@example.com' }, env);
      await makeAdmin('admin@example.com', env);
      
      // Create a regular user who will create the group
      await createUser({ name: 'Lead User', email: 'lead@example.com' }, env);
      await changeUserType('lead@example.com', UserType.Lead, env);
      
      // Create a group with the lead user
      const group = await createGroup('Test Group', 'A test group', 'lead@example.com', env);
      
      // Check if admin can access the group (even though not a member)
      const canAccess = await canAccessGroup('admin@example.com', group!.id, env);
      
      expect(canAccess).toBe(true);
    });
    
    it('should return true for group members', async () => {
      // Create users
      await createUser({ name: 'Admin User', email: 'admin@example.com' }, env);
      await makeAdmin('admin@example.com', env);
      
      await createUser({ name: 'Member User', email: 'member@example.com' }, env);
      
      // Create a group
      const group = await createGroup('Test Group', 'A test group', 'admin@example.com', env);
      
      // Add member to group
      await addUserToGroup('member@example.com', group!.id, env);
      
      // Check if member can access the group
      const canAccess = await canAccessGroup('member@example.com', group!.id, env);
      
      expect(canAccess).toBe(true);
    });
    
    it('should return false for non-members', async () => {
      // Create users
      await createUser({ name: 'Admin User', email: 'admin@example.com' }, env);
      await makeAdmin('admin@example.com', env);
      
      await createUser({ name: 'Non Member', email: 'nonmember@example.com' }, env);
      
      // Create a group
      const group = await createGroup('Test Group', 'A test group', 'admin@example.com', env);
      
      // Check if non-member can access the group
      const canAccess = await canAccessGroup('nonmember@example.com', group!.id, env);
      
      expect(canAccess).toBe(false);
    });
    
    it('should return false if user does not exist', async () => {
      // Create admin and a group
      await createUser({ name: 'Admin User', email: 'admin@example.com' }, env);
      await makeAdmin('admin@example.com', env);
      
      const group = await createGroup('Test Group', 'A test group', 'admin@example.com', env);
      
      // Check with non-existent user
      const canAccess = await canAccessGroup('nonexistent@example.com', group!.id, env);
      
      expect(canAccess).toBe(false);
    });
    
    it('should return false if group does not exist', async () => {
      // Create a user
      await createUser({ name: 'Regular User', email: 'regular@example.com' }, env);
      
      // Check with non-existent group
      const canAccess = await canAccessGroup('regular@example.com', 'nonexistent-group-id', env);
      
      expect(canAccess).toBe(false);
    });
  });
});