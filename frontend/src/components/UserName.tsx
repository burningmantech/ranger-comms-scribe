import React from 'react';
import { resolveUserEmail, useUserName } from '../services/userDirectory';

/**
 * Shows a stored user reference (id or email) as the person's name, email on hover.
 * `name`, when given, is a display name stored with the record (e.g. `rejectedByName`)
 * and is shown instead of the directory lookup.
 */
export const UserName: React.FC<{ value?: string | null; name?: string | null; className?: string }> = ({ value, name, className }) => {
  const resolved = useUserName(value);
  return (
    <span className={className} title={resolveUserEmail(value)}>
      {name || resolved}
    </span>
  );
};

export default UserName;
