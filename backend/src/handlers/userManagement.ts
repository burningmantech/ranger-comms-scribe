import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { UserType, User } from '../types';
import { withAuth } from '../authWrappers';
import { Env } from '../utils/sessionManager';
import { getObject, putObject } from '../services/cacheService';

export const router = AutoRouter({ base: '/api/users' });

// Update a user's type
router.put('/:email/type', withAuth, async (request: Request, env: Env) => {
  const user = (request as any).user as User;
  if (!user || user.userType !== UserType.Admin) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { email } = (request as any).params;
  const { userType } = await request.json();

  // Get the user
  const userObj = await getObject<User>(`user/${email}`, env);
  if (!userObj) {
    return json({ error: 'User not found' }, { status: 404 });
  }

  // Update user type
  userObj.userType = userType;
  
  // If changing to Admin, also set isAdmin flag for backward compatibility
  if (userType === UserType.Admin) {
    userObj.isAdmin = true;
  } else if (userObj.isAdmin) {
    // If demoting from Admin, remove isAdmin flag
    userObj.isAdmin = false;
  }

  // Update user
  await putObject(`user/${email}`, userObj, env, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { userId: userObj.id }
  });

  return json(userObj);
}); 