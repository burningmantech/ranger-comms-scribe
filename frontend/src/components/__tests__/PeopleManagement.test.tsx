import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { PeopleManagement } from '../PeopleManagement';
import { accessOf, canUseNewsletter, isReviewer } from '../../utils/access';

const PEOPLE = [
  { id: 'u1', name: 'Boss', email: 'boss@x.org', verified: true, isAdmin: true, commsCadre: false, councilRole: null },
  { id: 'u2', name: 'Help Desk', email: 'helpdesk@x.org', verified: true, isAdmin: false, commsCadre: true, councilRole: 'CommunicationsManager' },
  { id: 'u3', name: 'New Ranger', email: 'new@x.org', verified: false, isAdmin: false, commsCadre: false, councilRole: null },
];

let fetchMock: jest.Mock;

function json(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);
}

beforeEach(() => {
  localStorage.setItem('sessionId', 's');
  localStorage.setItem('user', JSON.stringify({ email: 'boss@x.org', isAdmin: true }));
  fetchMock = jest.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/admin/people')) return json({ people: PEOPLE });
    const m = url.match(/\/admin\/people\/([^/]+)\/access$/);
    if (m && init?.method === 'PUT') {
      const person = PEOPLE.find((p) => p.id === decodeURIComponent(m[1]))!;
      const patch = JSON.parse(String(init.body));
      if (patch.isAdmin === false && person.id === 'u1') return json({ error: "You can't remove your own Admin. Ask another Admin." }, 409);
      return json({ person: { ...person, ...patch } });
    }
    return json({ error: 'not found' }, 404);
  });
  (global as any).fetch = fetchMock;
});

const row = (email: string) => screen.getByTestId(`person-${email}`);

describe('People', () => {
  it('lists people with their roles, and filters them', async () => {
    render(<PeopleManagement />);
    await screen.findByText('Help Desk');
    expect((within(row('helpdesk@x.org')).getByLabelText('helpdesk@x.org council role') as HTMLSelectElement).value).toBe('CommunicationsManager');
    expect((within(row('new@x.org')).getByLabelText('new@x.org council role') as HTMLSelectElement).value).toBe('');
    expect((within(row('helpdesk@x.org')).getByLabelText('helpdesk@x.org Comms Cadre') as HTMLInputElement).checked).toBe(true);
    // You can't take away your own Admin
    expect((within(row('boss@x.org')).getByLabelText('boss@x.org Admin') as HTMLInputElement).disabled).toBe(true);

    // Nobody waits for approval: anyone signed in can submit requests
    expect(screen.queryByRole('button', { name: /Awaiting approval/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Approved' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Council/ }));
    expect(screen.getByText('Help Desk')).toBeInTheDocument();
    expect(screen.queryByText('New Ranger')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Everyone/ }));
    fireEvent.change(screen.getByLabelText('Search people'), { target: { value: 'help' } });
    expect(screen.getByText('Help Desk')).toBeInTheDocument();
    expect(screen.queryByText('Boss')).not.toBeInTheDocument();
  });

  it('saves each change at once: Comms Cadre, and one council role (changed or removed)', async () => {
    render(<PeopleManagement />);
    await screen.findByText('New Ranger');
    fireEvent.click(within(row('new@x.org')).getByLabelText('new@x.org Comms Cadre'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/admin\/people\/u3\/access$/), expect.objectContaining({ body: JSON.stringify({ commsCadre: true }) })));

    const council = within(row('helpdesk@x.org')).getByLabelText('helpdesk@x.org council role') as HTMLSelectElement;
    fireEvent.change(council, { target: { value: 'IntakeManager' } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: JSON.stringify({ councilRole: 'IntakeManager' }) })));
    await waitFor(() => expect(council.value).toBe('IntakeManager'));

    fireEvent.change(council, { target: { value: '' } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: JSON.stringify({ councilRole: null }) })));
  });

  it("puts a change back and says why when the server refuses it", async () => {
    // A stale copy of the page still lets the box be clicked; the server is the guard
    localStorage.setItem('user', JSON.stringify({ email: 'someone-else@x.org', isAdmin: true }));
    render(<PeopleManagement />);
    await screen.findByText('Boss');
    const box = within(row('boss@x.org')).getByLabelText('boss@x.org Admin') as HTMLInputElement;
    fireEvent.click(box);
    expect(await within(row('boss@x.org')).findByRole('alert')).toHaveTextContent("You can't remove your own Admin");
    expect(box.checked).toBe(true);
  });
});

describe('access (frontend)', () => {
  it('reads the access fields, and older records by their roles', () => {
    expect(accessOf({ accessVersion: 1, commsCadre: true, councilRole: 'CommunicationsManager', userType: 'CouncilManager' }))
      .toEqual({ isAdmin: false, commsCadre: true, councilRole: 'CommunicationsManager', council: true });
    expect(accessOf({ roles: ['CommsCadre'] })).toMatchObject({ commsCadre: true, council: false });
    expect(isReviewer({ accessVersion: 1, councilRole: 'IntakeManager' })).toBe(true);
    expect(canUseNewsletter({ accessVersion: 1, councilRole: 'CommunicationsManager' })).toBe(true);
    expect(canUseNewsletter({ accessVersion: 1, councilRole: 'IntakeManager' })).toBe(false);
  });

  it('reads a signed-in user saved before the change (councilRoles) as their first role', () => {
    expect(accessOf({ accessVersion: 1, commsCadre: true, councilRoles: ['CommunicationsManager'] })).toMatchObject({ councilRole: 'CommunicationsManager', council: true });
    expect(canUseNewsletter({ accessVersion: 1, councilRoles: ['CommunicationsManager'] })).toBe(true);
    expect(accessOf({ accessVersion: 1, councilRole: null, councilRoles: ['IntakeManager'] })).toMatchObject({ councilRole: null, council: false });
  });
});
