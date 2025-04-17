import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { Env, GetSession } from '../utils/sessionManager';
import { withAuthCheck } from '../authWrappers';
import { getUserNotificationSettings, updateUserNotificationSettings } from '../services/userService';

// Extend the Request interface to include user property
interface ExtendedRequest extends Request {
  user?: string;
  params: Record<string, string>;
}

export const router = AutoRouter({ base: '/user' });

// Get user settings
router.get('/settings', withAuthCheck, async (request: ExtendedRequest, env: Env) => {
  try {
    if (!request.user) {
      return json({ error: 'User not authenticated' }, { status: 401 });
    }

    console.log(`GET /user/settings called for user ${request.user}`);
    
    // Get the user's notification settings
    const notificationSettings = await getUserNotificationSettings(request.user, env);
    
    return json({
      userId: request.user,
      notificationSettings
    });
  } catch (error) {
    console.error('Error fetching user settings:', error);
    return json({ error: 'Error fetching user settings' }, { status: 500 });
  }
});

// Update user settings
router.put('/settings', withAuthCheck, async (request: ExtendedRequest, env: Env) => {
  try {
    if (!request.user) {
      return json({ error: 'User not authenticated' }, { status: 401 });
    }

    console.log(`PUT /user/settings called for user ${request.user}`);

    const { notificationSettings } = await request.json() as {
      notificationSettings: {
        notifyOnReplies: boolean;
        notifyOnGroupContent: boolean;
      }
    };

    if (!notificationSettings) {
      return json({ error: 'Notification settings are required' }, { status: 400 });
    }

    // Ensure all required properties are present, using defaults if missing
    const updatedSettings = {
      notifyOnReplies: notificationSettings.notifyOnReplies ?? true,
      notifyOnGroupContent: notificationSettings.notifyOnGroupContent ?? true
    };

    // Update the user's notification settings
    const updatedUser = await updateUserNotificationSettings(
      request.user,
      updatedSettings,
      env
    );

    if (!updatedUser) {
      return json({ error: 'Failed to update user settings' }, { status: 400 });
    }

    return json({
      message: 'User settings updated successfully',
      userId: request.user,
      notificationSettings: updatedSettings
    });
  } catch (error) {
    console.error('Error updating user settings:', error);
    return json({ error: 'Error updating user settings' }, { status: 500 });
  }
});