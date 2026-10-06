import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import ConditionsPopover from '../ConditionsPopover';
import { parsePeople, PeopleManagement } from '../PeopleManagement';
import MailingListsManager from '../MailingListsManager';
import { ApprovalGates } from '../../types/content';

const GATES: ApprovalGates = {
  councilManager: { met: false },
  commsCadre: { met: true, approverName: 'Help Desk' },
  requiredApprovers: {
    met: false, approved: 1, total: 2,
    details: [
      { email: 'pat@x.org', name: 'Pat', status: 'pending' },
      { email: 'sam@x.org', name: 'Sam', status: 'approved' },
    ],
  },
  trackedChanges: { met: true, pending: 0, total: 0 },
} as any;

describe('approval reminders in the conditions popover', () => {
  it('offers Remind for each unmet gate and waiting approver, and shows when they were reminded', async () => {
    const onRemind = jest.fn(async (target: string) => [{ target, to: ['x'], by: 'me@x.org', byName: 'Me', at: new Date().toISOString() }]);
    render(<ConditionsPopover gates={GATES} onRemind={onRemind} reminders={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /conditions met/ }));
    expect(screen.getByRole('button', { name: /Remind the Council/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remind the Comms Cadre/ })).not.toBeInTheDocument(); // met
    expect(screen.queryByRole('button', { name: /Remind Sam/ })).not.toBeInTheDocument(); // approved
    fireEvent.click(screen.getByRole('button', { name: /Remind Pat/ }));
    await waitFor(() => expect(onRemind).toHaveBeenCalledWith('pat@x.org'));
    expect(await screen.findByText(/Reminded .* by Me/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Remind Pat/ })).toBeDisabled();
  });

  it('says why a reminder failed, and hides Remind without permission', async () => {
    const onRemind = jest.fn(async () => { throw new Error('The Council was reminded today; try again tomorrow'); });
    const { unmount } = render(<ConditionsPopover gates={GATES} onRemind={onRemind} />);
    fireEvent.click(screen.getByRole('button', { name: /conditions met/ }));
    fireEvent.click(screen.getByRole('button', { name: /Remind the Council/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('try again tomorrow');
    unmount();
    render(<ConditionsPopover gates={GATES} />);
    fireEvent.click(screen.getByRole('button', { name: /conditions met/ }));
    expect(screen.queryByRole('button', { name: /Remind/ })).not.toBeInTheDocument();
  });
});

describe('Add people', () => {
  it('reads names and emails, one per line', () => {
    expect(parsePeople('Pat Ranger <Pat@Example.org>\nsam@example.org\nCasey, casey@example.org\nnot an address\npat@example.org')).toEqual({
      people: [
        { name: 'Pat Ranger', email: 'pat@example.org' },
        { name: 'sam', email: 'sam@example.org' },
        { name: 'Casey', email: 'casey@example.org' },
      ],
      bad: ['not an address'],
    });
  });

  it('adds them, gives each the chosen role, and says when a role could not be set', async () => {
    localStorage.setItem('sessionId', 's');
    const calls: Array<{ url: string; method: string; body?: any }> = [];
    (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method || 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/admin/bulk-create-users')) {
        return { ok: true, status: 200, json: async () => ({ users: [
          { id: 'casey@x.org', email: 'casey@x.org', name: 'Casey', approved: true, councilRoles: [] },
          { id: 'dana@x.org', email: 'dana@x.org', name: 'Dana', approved: true, councilRoles: [] },
        ] }) };
      }
      if (method === 'PUT' && url.includes('dana')) return { ok: false, status: 403, json: async () => ({ error: 'Not allowed' }) };
      if (method === 'PUT') return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ people: [] }) };
    });
    render(<PeopleManagement />);
    fireEvent.click(await screen.findByRole('button', { name: /Add people/ }));
    fireEvent.change(screen.getByLabelText(/one per line/), { target: { value: 'Casey <casey@x.org>\ndana@x.org' } });
    fireEvent.change(screen.getByLabelText('Role for the people added'), { target: { value: 'commsCadre' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 people' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Added 2; no role for dana@x.org (Not allowed)');
    expect(calls.find((c) => c.url.endsWith('/bulk-create-users'))!.body).toEqual({ users: [
      { name: 'Casey', email: 'casey@x.org', approved: true },
      { name: 'dana', email: 'dana@x.org', approved: true },
    ] });
    expect(calls.filter((c) => c.method === 'PUT').map((c) => [c.url.split('/people/')[1], c.body])).toEqual([
      ['casey%40x.org/access', { commsCadre: true }],
      ['dana%40x.org/access', { commsCadre: true }],
    ]);
  });
});

describe('Mailing lists', () => {
  beforeEach(() => {
    localStorage.setItem('sessionId', 's');
    const lists = [
      { id: 'announce', name: 'Ranger Announce', address: 'announce@x.org', audiences: ['singular'], active: true, builtIn: true },
      { id: 'l1', name: 'Allcom', address: 'allcom@x.org', audiences: ['allcom'], active: true },
    ];
    (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (!body.address.includes('@')) return { ok: false, status: 400, json: async () => ({ error: 'The address must be an email address' }) };
        lists.push({ id: 'l2', ...body, active: true });
        return { ok: true, status: 201, json: async () => ({ list: lists[2] }) };
      }
      return { ok: true, status: 200, json: async () => ({ lists, canManage: true }) };
    });
  });

  it('lists them and adds one', async () => {
    render(<MailingListsManager />);
    expect(await screen.findByText('Allcom')).toBeInTheDocument();
    expect(within(screen.getByTestId('list-announce@x.org')).getByText('Built in')).toBeInTheDocument();
    expect(within(screen.getByTestId('list-announce@x.org')).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '+ Add a mailing list' }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Intake Cadre'), { target: { value: 'Intake Cadre' } });
    fireEvent.change(screen.getByPlaceholderText('ranger-intake-cadre@burningman.org'), { target: { value: 'ranger-intake-cadre@burningman.org' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'JRS / Event Ops' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add list' }));
    expect(await screen.findByText('Intake Cadre')).toBeInTheDocument();
    const post = ((global as any).fetch as jest.Mock).mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(post[1].body)).toMatchObject({ name: 'Intake Cadre', address: 'ranger-intake-cadre@burningman.org', audiences: ['jrs'] });
  });
});
