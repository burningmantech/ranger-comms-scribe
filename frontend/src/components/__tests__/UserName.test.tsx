import React from 'react';
import { render, screen } from '@testing-library/react';
import { UserName } from '../UserName';
import { __resetUserDirectory } from '../../services/userDirectory';

const BOB_ID = 'ffacb9d3-27ba-4c1e-9d55-0123456789ab';
const UNKNOWN_ID = '0b5e8c2a-1111-4222-8333-444455556666';

describe('UserName', () => {
  beforeEach(() => {
    __resetUserDirectory([{ id: BOB_ID, name: 'Bob Ranger', email: 'bob@example.com' }]);
  });

  test('shows the name for a stored user id, email on hover', () => {
    render(<UserName value={BOB_ID} />);
    const el = screen.getByText('Bob Ranger');
    expect(el).toHaveAttribute('title', 'bob@example.com');
  });

  test('a stored name (e.g. rejectedByName) is shown as given', () => {
    render(<UserName value={UNKNOWN_ID} name="Carol" />);
    expect(screen.getByText('Carol')).toBeInTheDocument();
    expect(screen.queryByText(UNKNOWN_ID)).not.toBeInTheDocument();
  });

  test('never shows a raw id without a stored name', () => {
    render(<UserName value={UNKNOWN_ID} />);
    expect(screen.getByText('Unknown user')).toBeInTheDocument();
  });
});
