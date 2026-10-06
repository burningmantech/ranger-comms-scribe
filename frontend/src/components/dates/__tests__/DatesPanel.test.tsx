import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
      defaultName="Social"
      {...props}
    />,
  );
  return { onLinksChange, onReplaceText };
}

describe('DatesPanel', () => {
  it('offers to track a date it finds', () => {
    setup();
    expect(screen.getByText('6pm - 10pm on Sept. 1 2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Track every year…' })).toBeInTheDocument();
  });

  it('shows nothing when the text has no dates', () => {
    const { container } = render(
      <DatesPanel
        sources={[{ field: 'body', label: 'the text', text: 'See you there today' }]}
        links={[]}
        onLinksChange={jest.fn()}
        referenceYmd="2026-08-01"
        annualDates={[]}
        onAnnualDateAdded={jest.fn()}
        onReplaceText={jest.fn()}
        defaultName=""
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('links to an annual date that falls on the same day', () => {
    const { onLinksChange } = setup({ annualDates: [social] });
    expect(screen.getByText(/Looks like/)).toHaveTextContent('Looks like Ranger Social');
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(onLinksChange).toHaveBeenCalledWith([
      expect.objectContaining({ annualDateId: 'a1', field: 'body', text: '6pm - 10pm on Sept. 1 2026', year: 2026 }),
    ]);
  });

  it('says a linked date is right for this year', () => {
    const link: DateLink = { id: 'l1', annualDateId: 'a1', field: 'body', text: '6pm - 10pm on Sept. 1 2026', year: 2026 };
    const first = setup({ annualDates: [social], links: [link] });
    expect(screen.getByText(/Right for 2026/)).toBeInTheDocument();
    expect(first.onReplaceText).not.toHaveBeenCalled();
  });

  it('updates the text to next year in the same style', async () => {
    const link: DateLink = { id: 'l1', annualDateId: 'a1', field: 'body', text: '6pm - 10pm on Sept. 1 2026', year: 2026 };
    const { onLinksChange, onReplaceText } = setup({ annualDates: [social], links: [link], referenceYmd: '2027-07-01' });
    expect(screen.getByText(/2027: Tue Aug 31, 2027, 6–10pm/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update text' }));
    await waitFor(() => expect(onLinksChange).toHaveBeenCalled());
    expect(onReplaceText).toHaveBeenCalledWith('body', '6pm - 10pm on Sept. 1 2026', '6pm - 10pm on Aug. 31 2027');
    expect(onLinksChange).toHaveBeenCalledWith([{ ...link, text: '6pm - 10pm on Aug. 31 2027', year: 2027 }]);
  });

  it('lists a link whose text is gone', () => {
    const link: DateLink = { id: 'l1', annualDateId: 'a1', field: 'body', text: 'Aug. 30 2025', year: 2025 };
    setup({ annualDates: [social], links: [link], sources: [{ field: 'body', label: 'the text', text: 'No dates now' }] });
    expect(screen.getByText(/is no longer in the text/)).toBeInTheDocument();
  });
});
