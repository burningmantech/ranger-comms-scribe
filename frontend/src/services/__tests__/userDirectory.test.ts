import { __resetUserDirectory, resolveUserEmail, resolveUserName } from '../userDirectory';

describe('userDirectory', () => {
  beforeEach(() => {
    __resetUserDirectory([
      { id: '266dfebc-e54f-40b7-aac3-78c1d6ce92c2', name: 'Alex Young', email: 'alexander.young@gmail.com' },
      { id: 'b0b00000-0000-4000-8000-000000000000', email: 'nameless@example.com' },
    ]);
  });

  it('resolves ids and emails (case-insensitively) to names', () => {
    expect(resolveUserName('266dfebc-e54f-40b7-aac3-78c1d6ce92c2')).toBe('Alex Young');
    expect(resolveUserName('Alexander.Young@gmail.com')).toBe('Alex Young');
    expect(resolveUserEmail('266dfebc-e54f-40b7-aac3-78c1d6ce92c2')).toBe('alexander.young@gmail.com');
  });

  it('falls back to the email when a user has no name', () => {
    expect(resolveUserName('b0b00000-0000-4000-8000-000000000000')).toBe('nameless@example.com');
  });

  it('never shows a raw UUID', () => {
    expect(resolveUserName('99999999-9999-4999-8999-999999999999')).toBe('Unknown user');
  });

  it('passes through values that are already names or emails', () => {
    expect(resolveUserName('someone@example.com')).toBe('someone@example.com');
    expect(resolveUserName('Comms Cadre')).toBe('Comms Cadre');
    expect(resolveUserName(undefined)).toBe('');
  });
});
