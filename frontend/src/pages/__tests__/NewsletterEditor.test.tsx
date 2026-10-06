import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { NewsletterEditor } from '../NewsletterEditor';
import { NewsletterApiError, newsletterService } from '../../services/newsletterService';
import { EditionView, NewsletterEdition } from '../../types/newsletter';

jest.mock('../../components/editor/LexicalEditor', () => {
  return function MockLexicalEditor() {
    return <div data-testid="lexical-editor" />;
  };
});

jest.mock('../../services/newsletterService', () => {
  const actual = jest.requireActual('../../services/newsletterService');
  return {
    ...actual,
    newsletterService: {
      getEdition: jest.fn(),
      updateEdition: jest.fn(),
      preview: jest.fn(),
      getTray: jest.fn(),
      addFromSubmission: jest.fn(),
      decide: jest.fn(),
      submitForApproval: jest.fn(),
      sendTest: jest.fn(),
      send: jest.fn(),
    },
  };
});

const api = newsletterService as jest.Mocked<typeof newsletterService>;

function edition(overrides: Partial<NewsletterEdition> = {}): NewsletterEdition {
  return {
    id: 'ed-1',
    number: 11,
    title: 'Black Rock Ranger News',
    tagline: 'All the Dust that Fits Under Your Hat',
    subject: 'Tickets & Stuff',
    sections: [{
      id: 's1', kind: 'item', sourceSubmissionId: 'req-1', heading: 'Claim your tickets', body: '',
      photos: [], links: [], readMore: { kind: 'none' }, keyDates: [],
    }],
    calendar: [],
    calendarHidden: [],
    status: 'draft',
    version: 4,
    approvals: [],
    comments: [],
    createdBy: 'a', createdAt: '2026-10-01T00:00:00Z', updatedBy: 'a', updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

function view(e: NewsletterEdition = edition()): EditionView {
  return {
    edition: e,
    approval: { version: e.version, commsCadre: { met: false }, commsManager: { met: false }, rejectedBy: [], override: false },
    sources: { s1: { submissionId: 'req-1', title: 'Claim your tickets', status: 'approved', changed: false } },
    calendar: [],
    documents: {},
    permissions: { canOverride: false, isCommsManager: false, announceConfigured: true },
  };
}

function renderEditor() {
  return render(
    <MemoryRouter initialEntries={['/newsletter/editions/ed-1']}>
      <Routes>
        <Route path="/newsletter/editions/:id" element={<NewsletterEditor />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.useRealTimers();
  localStorage.setItem('user', JSON.stringify({ id: 'u2', email: 'user2@localhost', name: 'Test Reviewer', userType: 'CommsCadre', roles: ['CommsCadre'] }));
  Object.values(api).forEach((fn) => (fn as jest.Mock).mockReset());
  api.getEdition.mockResolvedValue(view());
  api.preview.mockResolvedValue({ subject: 'Tickets & Stuff - Ranger News #11', html: '<p>preview</p>', text: '', sizeBytes: 2048, warnings: ['A section has no heading'], to: 'announce@example.org', replyTo: null, version: 4 });
  api.getTray.mockResolvedValue({ ready: [], upcoming: [] });
});

describe('NewsletterEditor', () => {
  it('shows the edition, its sections, the subject line and the preview warnings', async () => {
    renderEditor();
    expect(await screen.findByRole('heading', { name: 'Ranger News #11' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Claim your tickets' })).toBeInTheDocument();
    expect(screen.getByText('Tickets & Stuff - Ranger News #11', { selector: 'strong' })).toBeInTheDocument();
    expect(await screen.findByText(/A section has no heading/)).toBeInTheDocument();
    expect(screen.getByText('From a request')).toBeInTheDocument();
  });

  it('autosaves with the version it edited, leaving out rows that are not complete', async () => {
    api.updateEdition.mockImplementation(async (_id, version, patch) => view(edition({ ...patch, version: version + 1 } as any)));
    renderEditor();
    await screen.findByRole('heading', { name: 'Ranger News #11' });

    jest.useFakeTimers();
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Tickets, Travel & Operators' } });
    // A link still being typed, and an empty date row: not sent yet
    fireEvent.click(screen.getByRole('button', { name: '+ Add a link' }));
    fireEvent.change(screen.getByLabelText('Link 1 address'), { target: { value: 'https://exa' } });
    fireEvent.change(screen.getByLabelText('Link 1 address'), { target: { value: 'not a url' } });
    await act(async () => { jest.advanceTimersByTime(1600); });
    jest.useRealTimers();

    await waitFor(() => expect(api.updateEdition).toHaveBeenCalledTimes(1));
    const [, version, patch] = api.updateEdition.mock.calls[0];
    expect(version).toBe(4);
    expect(patch.subject).toBe('Tickets, Travel & Operators');
    expect(patch.sections![0].links).toEqual([]);
    expect(patch.sections![0].sourceSubmissionId).toBe('req-1');
    await waitFor(() => expect(screen.getByText('All changes saved')).toBeInTheDocument());
  });

  it('stops and asks when someone else saved first', async () => {
    const theirs = edition({ version: 5, updatedBy: 'someone@example.org', subject: 'Their subject' });
    api.updateEdition.mockRejectedValue(new NewsletterApiError(409, 'Someone else saved this edition.', { conflict: true, edition: theirs }));
    renderEditor();
    await screen.findByRole('heading', { name: 'Ranger News #11' });

    jest.useFakeTimers();
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Mine' } });
    await act(async () => { jest.advanceTimersByTime(1600); });
    jest.useRealTimers();

    expect(await screen.findByText('Someone else saved this edition')).toBeInTheDocument();
    expect(screen.getByText('Not saved: someone else saved')).toBeInTheDocument();

    // Keep mine: saved again on top of their version
    api.updateEdition.mockReset();
    api.updateEdition.mockImplementation(async (_id, version, patch) => view(edition({ ...patch, version: version + 1 } as any)));
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine (replace theirs)' }));
    await waitFor(() => expect(api.updateEdition).toHaveBeenCalledTimes(1));
    expect(api.updateEdition.mock.calls[0][1]).toBe(5);
    expect(api.updateEdition.mock.calls[0][2].subject).toBe('Mine');
  });

  it('adds a request from the tray and shows the new section', async () => {
    api.getTray.mockResolvedValue({
      ready: [{ id: 'req-2', title: 'Join the Operators!', status: 'approved', submittedAt: '2026-10-01', headline: 'Join the Operators!', hasBlurb: false, photoCount: 0, keyDateCount: 1, readMore: 'url', writingHelp: { document: false, blurb: true } }],
      upcoming: [],
    });
    const added = edition({
      version: 5,
      sections: [
        ...edition().sections,
        { id: 's2', kind: 'item', sourceSubmissionId: 'req-2', heading: 'Join the Operators!', body: '', photos: [], links: [], readMore: { kind: 'none' }, keyDates: [] },
      ],
    });
    api.addFromSubmission.mockResolvedValue(view(added));
    renderEditor();
    await screen.findByRole('heading', { name: 'Ranger News #11' });

    fireEvent.click(screen.getByRole('tab', { name: 'Add from requests' }));
    expect(await screen.findByText('Needs a blurb written')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.addFromSubmission).toHaveBeenCalledWith('ed-1', 'req-2'));
    expect(await screen.findByRole('heading', { name: 'Join the Operators!', level: 3 })).toBeInTheDocument();
  });

  it('approves the version on screen', async () => {
    api.decide.mockResolvedValue(view(edition({ status: 'in_review' })));
    renderEditor();
    await screen.findByRole('heading', { name: 'Ranger News #11' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith('ed-1', 4, 'approved'));
  });

  it('is read-only once sent', async () => {
    api.getEdition.mockResolvedValue(view(edition({ status: 'sent', sentAt: '2026-10-02T00:00:00Z' })));
    renderEditor();
    await screen.findByRole('heading', { name: 'Ranger News #11' });
    expect(screen.getByLabelText('Subject')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View the public page' })).toHaveAttribute('href', '/newsletter/11');
  });
});
