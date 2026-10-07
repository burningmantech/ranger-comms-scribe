import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { Env, GetSession } from '../utils/sessionManager';
import { withAuth } from '../authWrappers';
import { User } from '../types';
import { getUserNotificationSettings, updateUserNotificationSettings, getAllUsers } from '../services/userService';

// Extend the Request interface to include user property
interface ExtendedRequest extends Request {
  user?: string; // typed as a string for Request; withAuth sets the whole User (see userEmail)
  params: Record<string, string>;
}

// withAuth puts the signed-in User on request.user
const userEmail = (request: ExtendedRequest): string => String((request.user as unknown as User).email || '').toLowerCase();

export const router = AutoRouter({ base: '/api/user' });

// Everyone who has signed in or been added (name + email only), for approver suggestions
router.get('/approvers', withAuth, async (request: ExtendedRequest, env: Env) => {
  try {
    const users = await getAllUsers(env);
    const approvers = users
      .filter(u => u && u.email)
      .map(u => ({ name: u.name, email: u.email }));
    return json({ users: approvers });
  } catch (error) {
    console.error('Error fetching approvers:', error);
    return json({ error: 'Error fetching approvers' }, { status: 500 });
  }
});

// Get user settings
// Directory for showing people by name: tracked changes, submissions and comments
// store user ids (UUIDs), and the UI resolves them here. Same exposure as
// /approvers (name + email) plus the id; includes unapproved users so their
// earlier changes still show a name.
router.get('/directory', withAuth, async (request: ExtendedRequest, env: Env) => {
  try {
    const users = await getAllUsers(env);
    return json({
      users: users.map(u => ({ id: u.id, name: u.name, email: u.email })),
    });
  } catch (error) {
    console.error('Error fetching user directory:', error);
    return json({ error: 'Error fetching user directory' }, { status: 500 });
  }
});

router.get('/settings', withAuth, async (request: ExtendedRequest, env: Env) => {
  try {
    if (!request.user) {
      return json({ error: 'User not authenticated' }, { status: 401 });
    }

    console.log(`GET /user/settings called for user ${userEmail(request)}`);
    
    // Get the user's notification settings
    const notificationSettings = await getUserNotificationSettings(userEmail(request), env);
    
    return json({
      userId: userEmail(request),
      notificationSettings
    });
  } catch (error) {
    console.error('Error fetching user settings:', error);
    return json({ error: 'Error fetching user settings' }, { status: 500 });
  }
});

// Update user settings
router.put('/settings', withAuth, async (request: ExtendedRequest, env: Env) => {
  try {
    if (!request.user) {
      return json({ error: 'User not authenticated' }, { status: 401 });
    }

    console.log(`PUT /user/settings called for user ${userEmail(request)}`);

    const { notificationSettings } = await request.json() as {
      notificationSettings: {
        notifyOnReplies?: boolean;
        submitterUpdates?: boolean;
      }
    };

    if (!notificationSettings) {
      return json({ error: 'Notification settings are required' }, { status: 400 });
    }

    // A setting left out keeps its current value
    const current = await getUserNotificationSettings(userEmail(request), env);
    const updatedSettings = {
      notifyOnReplies: typeof notificationSettings.notifyOnReplies === 'boolean' ? notificationSettings.notifyOnReplies : current.notifyOnReplies,
      submitterUpdates: typeof notificationSettings.submitterUpdates === 'boolean' ? notificationSettings.submitterUpdates : current.submitterUpdates
    };

    // Update the user's notification settings
    const updatedUser = await updateUserNotificationSettings(
      userEmail(request),
      updatedSettings,
      env
    );

    if (!updatedUser) {
      return json({ error: 'Failed to update user settings' }, { status: 400 });
    }

    return json({
      message: 'User settings updated successfully',
      userId: userEmail(request),
      notificationSettings: updatedSettings
    });
  } catch (error) {
    console.error('Error updating user settings:', error);
    return json({ error: 'Error updating user settings' }, { status: 500 });
  }
});