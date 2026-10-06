import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { CommsCalendar } from '../CommsCalendar';
import { commsCalendarService } from '../../services/commsCalendarService';
import { CommsCalendarEntry } from '../../types/commsCalendar';
import { cycleStartYear, localToday } from '../../utils/commsCalendar';

jest.mock('../../config', () => ({ API_URL: 'http://test-api' }));
jest.mock('../../contexts/ContentContext', () => ({ useContent: () => ({ submissions: [] }) }));
jest.mock('../../services/commsCalendarService', () => ({
  commsCalendarService: {
    list: jest.fn(),
    upcoming: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    nudge: jest.fn(),
    importEntries: jest.fn(),
    fromSubmission: jest.fn(),
  },
}));

const service = commsCalendarService as jest.Mocked<typeof commsCalendarService>;
const cycle = cycleStartYear(localToday());

function entry(overrides: Partial<CommsCalendarEntry> = {}): CommsCalendarEntry {
  return {
    id: 'e1', subject: 'Thank you Rangers', targetDate: `${cycle}-09-15`, dateSent: `${cycle}-09-17`,
    method: 'Announce', team: 'Council', contactEmails: ['council@example.org'], comments: 'HB',
    nudges: [], source: 'manual', createdBy: 'c@example.org', createdAt: '2025-09-01T00:00:00Z', updatedAt: '2025-09-01T00:00:00Z',
    ...overrides,
  };
}

function renderPage() {
  return render(<MemoryRouter><CommsCalendar /></MemoryRouter>);
}

describe('CommsCalendar page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    const last = entry({ id: 'last', targetDate: `${cycle - 1}-09-15`, dateSent: `${cycle - 1}-09-17` });
    service.list.mockResolvedValue({
      entries: [
        last,
        entry({ id: 'cur', subject: 'Calling All Shiny Pennies', team: 'RIDE Delegation', method: 'Both', link: 'https://example.org/m' }),
      ],
      canEdit: true,
    });
    service.upcoming.mockResolvedValue({ items: [{ entry: last, anniversary: `${cycle}-09-15`, daysUntil: 9, overdue: false }] });
  });

  it('shows upcoming anniversaries for the chosen window', async () => {
    renderPage();
    expect(await screen.findByText('in 9 days')).toBeInTheDocument();
    expect(service.upcoming).toHaveBeenCalledWith(42, localToday());

    fireEvent.change(screen.getByLabelText('Window'), { target: { value: '12' } });
    await waitFor(() => expect(service.upcoming).toHaveBeenLastCalledWith(84, localToday()));
  });

  it('lists this cycle\'s entries with links', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'All entries' }));
    const link = screen.getByRole('link', { name: 'Calling All Shiny Pennies' });
    expect(link).toHaveAttribute('href', 'https://example.org/m');
    // Last cycle's entry is under its own year
    expect(screen.queryByText('Thank you Rangers')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Cycle'), { target: { value: 'all' } });
    expect(screen.getByText('Thank you Rangers')).toBeInTheDocument();
  });

  it('hides every action from read-only viewers', async () => {
    service.list.mockResolvedValue({ entries: [entry()], canEdit: false });
    renderPage();
    await screen.findByText('in 9 days');
    expect(screen.queryByRole('button', { name: 'Nudge' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add entry' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'All entries' }));
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('nudges the recipients as edited', async () => {
    service.nudge.mockResolvedValue({ entry: entry(), sentTo: [] });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Nudge' }));
    const dialog = screen.getByRole('dialog', { name: 'Nudge the team' });
    fireEvent.change(within(dialog).getByLabelText('Recipients'), { target: { value: 'a@example.org, B@example.org' } });
    fireEvent.change(within(dialog).getByLabelText('Note'), { target: { value: 'Again this year?' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send nudge' }));
    await waitFor(() => expect(service.nudge).toHaveBeenCalledWith('last', ['a@example.org', 'b@example.org'], 'Again this year?'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('starts this year\'s entry from last year\'s', async () => {
    service.create.mockResolvedValue(entry({ id: 'new' }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: "This year's entry" }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(service.create).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'Thank you Rangers', carriedFromId: 'last', targetDate: `${cycle}-09-15`, dateSent: null,
      team: 'Council', contactEmails: ['council@example.org'],
    })));
  });

  it('imports only the rows left ticked', async () => {
    service.importEntries.mockResolvedValue({ created: 1, skipped: [], entries: [] });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Import CSV' }));
    const dialog = screen.getByRole('dialog', { name: 'Import from the spreadsheet' });
    const csv = 'Email subject,Target send date,Method of Publishinig,Date sent,Responsible Team\n'
      + 'Thank you Rangers,Sep-15,Announce,Sent by VCs,Council\n'
      + 'Upcoming Ranger Trainings Want YOU!,Apr-20,Announce,,Training Academy\n';
    const file = new File([csv], 'sheet.csv', { type: 'text/csv' });
    // jsdom's File has no text()
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(within(dialog).getByLabelText('CSV file'), { target: { files: [file] } });

    expect(await within(dialog).findByText('Date sent: "Sent by VCs" is not a date')).toBeInTheDocument();
    // Last cycle's "Thank you Rangers" is already there
    expect(within(dialog).getByText('Already in the calendar')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText('Include row 2'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import 1 row' }));

    await waitFor(() => expect(service.importEntries).toHaveBeenCalledTimes(1));
    const rows = service.importEntries.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: 'Upcoming Ranger Trainings Want YOU!', targetDate: `${cycle}-04-20`, team: 'Training Academy' });
    expect(await within(dialog).findByText('added.', { exact: false })).toBeInTheDocument();
  });
});
