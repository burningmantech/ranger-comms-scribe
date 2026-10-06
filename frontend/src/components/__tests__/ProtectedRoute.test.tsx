import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ProtectedRoute } from '../ProtectedRoute';
import { UserType } from '../../types';

const signIn = (userType: UserType, extra: Record<string, unknown> = {}) => {
  localStorage.setItem('user', JSON.stringify({
    id: 'u1', email: 'ranger@example.com', name: 'Ranger', userType, roles: [], ...extra,
  }));
};

const Where: React.FC = () => <div data-testid="path">{useLocation().pathname}</div>;

// The app's routes around a protected page: `/` and the catch-all redirect to /requests,
// so a protected page that redirected to `/` would loop.
function renderAt(path: string, allowedRoles?: UserType[]) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<Navigate to="/requests" replace />} />
        <Route path="/login" element={<div>Login page</div>} />
        <Route
          path="/requests"
          element={<ProtectedRoute element={<div>Requests page</div>} allowedRoles={allowedRoles} />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Where />
    </MemoryRouter>
  );
}

describe('ProtectedRoute', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    localStorage.clear();
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // A redirect loop shows up as React's "Maximum update depth exceeded" error
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringMatching(/Maximum update depth/), expect.anything());
    consoleError.mockRestore();
    localStorage.clear();
  });

  it.each([UserType.Member, UserType.Lead, UserType.Public, UserType.CommsCadre])(
    'shows the page to a signed-in %s',
    (userType) => {
      signIn(userType);
      renderAt('/requests');
      expect(screen.getByText('Requests page')).toBeInTheDocument();
      expect(screen.getByTestId('path')).toHaveTextContent('/requests');
    }
  );

  it('reaches the page from / for a Member without looping', () => {
    signIn(UserType.Member);
    renderAt('/');
    expect(screen.getByText('Requests page')).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent('/requests');
  });

  it('sends a visitor with no user to /login', () => {
    renderAt('/requests');
    expect(screen.getByText('Login page')).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent('/login');
  });

  it('sends a visitor with an unreadable user to /login', () => {
    localStorage.setItem('user', '{not json');
    renderAt('/');
    expect(screen.getByText('Login page')).toBeInTheDocument();
  });

  it('shows an access message, not a redirect, when the user type is not allowed', () => {
    signIn(UserType.Member);
    renderAt('/', [UserType.CommsCadre]);
    expect(screen.getByRole('alert')).toHaveTextContent("You don't have access");
    expect(screen.queryByText('Requests page')).not.toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent('/requests');
  });

  it('always lets an Admin through a role check', () => {
    signIn(UserType.Member, { isAdmin: true });
    renderAt('/requests', [UserType.CommsCadre]);
    expect(screen.getByText('Requests page')).toBeInTheDocument();
  });
});
