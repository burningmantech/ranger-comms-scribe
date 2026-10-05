import React from 'react';
import { resolveUserEmail, useUserName } from '../services/userDirectory';

/** Shows a stored user reference (id or email) as the person's name, email on hover. */
export const UserName: React.FC<{ value?: string | null; className?: string }> = ({ value, className }) => {
  const name = useUserName(value);
  return (
    <span className={className} title={resolveUserEmail(value)}>
      {name}
    </span>
  );
};

export default UserName;
