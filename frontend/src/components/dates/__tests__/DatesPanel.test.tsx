import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import DatesPanel from '../DatesPanel';
import { AnnualDate, DateLink } from '../../../types/annualDates';

const social: AnnualDate = {
  id: 'a1',
  name: 'Ranger Social',
  rule: { kind: 'laborDay', offsetDays: -6 },
  startTime: '18:00',
  endTime: '22:00',
  createdBy: 'x@example.org',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const TEXT = 'Join us 6pm - 10pm on Sept. 1 2026 at HQ.';

function setup(props: Partial<React.ComponentProps<typeof DatesPanel>> = {}) {
  const onLinksChange = jest.fn();
  const onReplaceText = jest.fn().mockResolvedValue(true);
  render(
    <DatesPanel
      sources={[{ field: 'body', label: 'the text', text: TEXT }]}
      links={[]}
      onLinksChange={onLinksChange}
      referenceYmd="2026-08-01"
      annualDates={[]}
      onAnnualDateAdded={jest.fn()}
      onReplaceText={onReplaceText}
      {...props}
    />,
  );
  return { onLinksChange, onReplaceText };
}

describe('DatesPanel', () => {
  it('shows each date with the words around it, and offers to track it', () => {
    setup();
    const row = screen.getByTestId('date-row');
    expect(row).toHaveTextContent('Tue Sep 1, 2026, 6–10pm');
    expect(row).toHaveTextContent('Join us 6pm - 10pm on Sept. 1 2026 at HQ.');
    expect(within(row).getByText('6pm - 10pm on Sept. 1 2026').tagName).toBe('MARK');
    expect(screen.getByRole('button', { name: 'Track every year…' })).toBeInTheDocument();
  });

  it('shows nothing when the text has no dates', () => {
    const { container } = render(
      <DatesPanel
        sources={[{ field: 'body', label: 'the text', text: 'See you there today, one minute after the gate opens' }]}
        links={[]}
        onLinksChange={jest.fn()}
        referenceYmd="2026-08-01"
        annualDates={[]}
        onAnnualDateAdded={jest.fn()}
        onReplaceText={jest.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('groups every mention of the same date in one row', () => {
    setup({
      sources: [{
        field: 'body',
        label: 'the text',
        text: 'Claim by 23:59 PT on Sunday, July 12th. Passes go out after July 12th. Vehicle passes by July 31st.',
      }],
    });
    const rows = screen.getAllByTestId('date-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('2 mentions');
    expect(rows[1]).toHaveTextContent('Fri Jul 31, 2026');
  });

  it('links every mention of a date to an annual date that falls on it', () => {
    const { onLinksChange } = setup({
      annualDates: [social],
      sources: [{ field: 'body', label: 'the text', text: `${TEXT} See you Tuesday, Sept. 1!` }],
    });
    expect(screen.getByText(/Looks like/)).toHaveTextContent('Looks like Ranger Social');
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(onLinksChange).toHaveBeenCalledWith([
      expect.objectContaining({ annualDateId: 'a1', field: 'body', text: '6pm - 10pm on Sept. 1 2026', year: 2026 }),
      expect.objectContaining({ annualDateId: 'a1', field: 'body', text: 'Tuesday, Sept. 1', year: 2026 }),
    ]);
  });

  it('says a linked date is right for this year', () => {
    const link: DateLink = { id: 'l1', annualDateId: 'a1', field: 'body', text: '6pm - 10pm on Sept. 1 2026', year: 2026 };
    const { onReplaceText } = setup({ annualDates: [social], links: [link] });
    expect(screen.getByText(/Right for 2026/)).toBeInTheDocument();
    expect(onReplaceText).not.toHaveBeenCalled();
  });

  it('updates every mention to next year in its own style, last first', async () => {
    const text = 'Join us 6pm - 10pm on Sept. 1 2026 at HQ. Again: Sept. 1 2026.';
    const links: DateLink[] = [
      { id: 'l1', annualDateId: 'a1', field: 'body', text: '6pm - 10pm on Sept. 1 2026', year: 2026 },
      { id: 'l2', annualDateId: 'a1', field: 'body', text: 'Sept. 1 2026', year: 2026 },
    ];
    const { onLinksChange, onReplaceText } = setup({
      annualDates: [social], links, referenceYmd: '2027-07-01', sources: [{ field: 'body', label: 'the text', text }],
    });
    expect(screen.getByText(/2027: Tue Aug 31, 2027, 6–10pm/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update all 2' }));
    await waitFor(() => expect(onLinksChange).toHaveBeenCalled());
    expect(onReplaceText.mock.calls).toEqual([
      // "Sept. 1 2026" also appears inside the first mention, so the second one is its 2nd occurrence
      ['body', 'Sept. 1 2026', 'Aug. 31 2027', 1],
      ['body', '6pm - 10pm on Sept. 1 2026', '6pm - 10pm on Aug. 31 2027', 0],
    ]);
    expect(onLinksChange).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ annualDateId: 'a1', text: 'Aug. 31 2027', year: 2027 }),
      expect.objectContaining({ annualDateId: 'a1', text: '6pm - 10pm on Aug. 31 2027', year: 2027 }),
    ]));
  });

  it('shows a mention in the text when asked', () => {
    const onShowMention = jest.fn();
    setup({ onShowMention });
    fireEvent.click(screen.getByTitle('Show in the text'));
    expect(onShowMention).toHaveBeenCalledWith(expect.objectContaining({ key: 'body|6pm - 10pm on Sept. 1 2026|0' }));
  });

  it('lists a link whose text is gone', () => {
    const link: DateLink = { id: 'l1', annualDateId: 'a1', field: 'body', text: 'Aug. 30 2025', year: 2025 };
    setup({ annualDates: [social], links: [link], sources: [{ field: 'body', label: 'the text', text: 'No dates now' }] });
    expect(screen.getByText(/is no longer in the text/)).toBeInTheDocument();
  });
});
