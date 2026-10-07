import { API_URL } from '../config';
import { User } from '../types';

// Event to notify login state changes
export const USER_LOGIN_EVENT = 'user_login_change';

// Helper to dispatch login state change event
const dispatchLoginStateChange = (user: User | null) => {
    const event = new CustomEvent(USER_LOGIN_EVENT, { detail: user });
    window.dispatchEvent(event);
};

/**
 * Sign in with a new session: store the person's record as the server has it (GET /auth/me,
 * with their access: utils/access.ts) and the review permissions (GET /admin/user-roles).
 * `fallback` is used only if /auth/me can't be read. Returns the stored user.
 */
export const handleUserLogin = async (fallback: Partial<User>, sessionId: string): Promise<User> => {
    const headers = { Authorization: `Bearer ${sessionId}` };
    let user = { ...fallback } as User;
    try {
        const me = await fetch(`${API_URL}/auth/me`, { headers });
        if (me.ok) {
            const data = await me.json();
            if (data?.user) user = data.user as User;
        }
    } catch (error) {
        console.error('Error fetching the signed-in user:', error);
    }
    try {
        const response = await fetch(`${API_URL}/admin/user-roles`, { headers });
        if (response.ok) {
            const data = await response.json();
            if (data?.permissions) localStorage.setItem('userPermissions', JSON.stringify(data.permissions));
        }
    } catch (error) {
        console.error('Error fetching user permissions:', error);
    }

    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('sessionId', sessionId);
    dispatchLoginStateChange(user);
    return user;
};

export const LogoutUserReact = async (navigate?: (path: string) => void) => {
    const sessionId = localStorage.getItem('sessionId');
    await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionId}`,
      },
    });
    localStorage.removeItem('user');
    localStorage.removeItem('sessionId');
    localStorage.removeItem('userPermissions');
    localStorage.removeItem('commsRequestDraft');
    dispatchLoginStateChange(null);


    if (navigate) {
        navigate('/'); // Redirect to home page if navigate function is provided
    }
};
