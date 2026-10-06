import React from 'react';
import { Navigate } from 'react-router-dom';
import { User, UserType } from '../types';

/** The signed-in user saved at login, or null when there is none (or it can't be read). */
function readStoredUser(): User | null {
  try {
    const userJson = localStorage.getItem('user');
    if (!userJson) return null;
    const user = JSON.parse(userJson);
    return user && typeof user === 'object' ? (user as User) : null;
  } catch (err) {
    console.error('Error reading the signed-in user:', err);
    return null;
  }
}

/**
 * Renders `element` for a signed-in user, and sends everyone else to /login.
 *
 * The backend authorizes every request, so by default any signed-in user may open the
 * page (Members and Leads are the Rangers who submit content). `allowedRoles` narrows it
 * to those user types (Admins always pass); anyone else sees an access message. It never
 * redirects to `/`, which redirects back to a protected page.
 */
export const ProtectedRoute: React.FC<{
  element: React.ReactElement;
  allowedRoles?: UserType[];
}> = ({ element, allowedRoles }) => {
  const user = readStoredUser();
  if (!user) {
    return <Navigate to="/login" replace />;
  }

  const isAdmin = user.isAdmin === true || user.userType === UserType.Admin;
  if (allowedRoles && !isAdmin && !allowedRoles.includes(user.userType)) {
    return (
      <div className="container mt-4" role="alert">
        <h2>You don't have access to this page</h2>
        <p>Ask an admin if you think you should.</p>
      </div>
    );
  }

  return element;
};

export default ProtectedRoute;
