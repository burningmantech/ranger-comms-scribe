import { User, UserType } from '../types';

/**
 * Who sees the newsletter pages: Admins and the Comms Cadre (by user type or role). The
 * backend also counts members of the active Comms Cadre list and decides every request.
 */
export function canUseNewsletter(user: Partial<User> | null | undefined): boolean {
  if (!user) return false;
  return user.isAdmin === true
    || user.userType === UserType.Admin
    || user.userType === UserType.CommsCadre
    || (user.roles || []).includes('CommsCadre')
    || (user.roles || []).includes('Admin');
}

export function storedUser(): Partial<User> | null {
  try {
    const json = localStorage.getItem('user');
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}
