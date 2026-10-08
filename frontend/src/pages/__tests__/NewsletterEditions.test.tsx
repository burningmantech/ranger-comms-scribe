import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NewsletterEditions } from '../NewsletterEditions';
import { newsletterService } from '../../services/newsletterService';
import { EditionSummary } from '../../types/newsletter';

jest.mock('../../services/newsletterService', () => {
  const actual = jest.requireActual('../../services/newsletterService');
  return {
    ...actual,
    newsletterService: { listEditions: jest.fn(), createEdition: jest.fn() },
  };
});

const api = newsletterService as jest.Mocked<typeof newsletterService>;

const summary: EditionSummary = {
  id: 'ed-1',
  number: 11,
  subject: 'Tickets & Stuff',
  status: 'in_review',
  sectionCount: 2,
  updatedAt: '2026-10-01T00:00:00Z',
  approval: { version: 3, commsCadre: { met: true }, commsManager: { met: false }, rejectedBy: [], override: false },
};

function renderList() {
  return render(<MemoryRouter><NewsletterEditions /></MemoryRouter>);
}

beforeEach(() => {
  api.listEditions.mockReset();
  api.createEdition.mockReset();
  api.listEditions.mockResolvedValue({ editions: [summary], nextNumber: 12 });
});

describe('NewsletterEditions', () => {
  it('lets the Comms Cadre start an edition', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u2', email: 'user2@localhost', isAdmin: false, commsCadre: true, councilRole: null }));
    renderList();
    expect(await screen.findByText('Tickets & Stuff')).toBeInTheDocument();
    expect(await screen.findByLabelText('Start Ranger News #12')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New edition' })).toBeInTheDocument();
  });

  it('shows the Communications Manager the list without the new-edition form', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 'cm', email: 'cm@localhost', isAdmin: false, commsCadre: false, councilRole: 'CommunicationsManager' }));
    renderList();
    expect(await screen.findByText('Tickets & Stuff')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Start Ranger News/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New edition' })).not.toBeInTheDocument();
    expect(screen.getByText(/The Comms Cadre build the editions/)).toBeInTheDocument();
  });
});
