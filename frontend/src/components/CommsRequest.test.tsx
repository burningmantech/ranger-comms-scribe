import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CommsRequest from './CommsRequest';

const mockSaveSubmission = jest.fn();

jest.mock('../contexts/ContentContext', () => ({
  useContent: () => ({ saveSubmission: mockSaveSubmission }),
}));

// Behaves like the real editor where it matters here: it reads `initialContent` only when it
// mounts, applies a `content` prop when it changes, and reports edits (never its own loading)
// through onChange as Lexical JSON. Typing into the textarea is an edit.
jest.mock('./editor/LexicalEditor', () => {
  const ReactLib = jest.requireActual('react');
  const textOf = (json?: string) => {
    if (!json) return '';
    try {
      const out: string[] = [];
      const walk = (n: any) => {
        if (typeof n?.text === 'string') out.push(n.text);
        (n?.children || []).forEach(walk);
      };
      walk(JSON.parse(json).root);
      return out.join('');
    } catch {
      return json;
    }
  };
  const toJson = (text: string) => JSON.stringify({
    root: { type: 'root', children: [{ type: 'paragraph', children: text ? [{ type: 'text', text }] : [] }] },
  });
  return function MockLexicalEditor({ initialContent, content, onChange, placeholder }: any) {
    const [text, setText] = ReactLib.useState(() => textOf(initialContent));
    ReactLib.useEffect(() => {
      if (content !== undefined && content !== null) setText(textOf(content));
    }, [content]);
    return (
      <textarea
        data-testid="lexical-editor"
        aria-label={placeholder}
        value={text}
        onChange={(e: any) => {
          setText(e.target.value);
          onChange?.(null, toJson(e.target.value));
        }}
      />
    );
  };
});

jest.mock('./TemplatePicker', () => {
  return function MockTemplatePicker() {
    return null;
  };
});

// Pat is an approved user who is not a council manager: picking Pat used to call the
// admin-only PUT /admin/council-managers (only the non-council branch did).
const APPROVERS = [
  { name: 'Pat Approver', email: 'pat@example.com' },
  { name: 'Casey Manager', email: 'casey@example.com' },
];
const COUNCIL = [{ email: 'casey@example.com', role: 'CommunicationsManager', active: true }];
const APPROVER_ERROR = /Please add at least one approver/;

let fetchMock: jest.Mock;

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('sessionId', 'test-session');
  localStorage.setItem('user', JSON.stringify({ id: 'member-1', email: 'member@example.com', name: 'Test Member' }));
  mockSaveSubmission.mockReset();
  mockSaveSubmission.mockResolvedValue(undefined);
  fetchMock = jest.fn((url: string) => {
    if (url.endsWith('/user/approvers')) return jsonResponse({ users: APPROVERS });
    if (url.endsWith('/council/members')) return jsonResponse(COUNCIL);
    return jsonResponse({ error: 'forbidden' }, 403);
  });
  (global as any).fetch = fetchMock;
  if (!(global.crypto as any)?.randomUUID) {
    Object.defineProperty(global, 'crypto', {
      configurable: true,
      value: { ...(global.crypto || {}), randomUUID: () => 'uuid-' + Math.random().toString(16).slice(2) },
    });
  }
});

function renderForm(path = '/comms-request') {
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <CommsRequest />
    </MemoryRouter>
  );
  const form = utils.container.querySelector('form') as HTMLFormElement;
  return { ...utils, form };
}

const activeStep = (container: HTMLElement) =>
  Number(container.querySelector('.step-circle.active')?.textContent);

const field = (container: HTMLElement, name: string) =>
  container.querySelector(`[name="${name}"]`) as HTMLInputElement;

function fillStep1(container: HTMLElement) {
  fireEvent.change(field(container, 'suggestedSubjectLine'), { target: { value: 'Subject' } });
  fireEvent.change(field(container, 'description'), { target: { value: 'Description' } });
  fireEvent.change(field(container, 'signatureText'), { target: { value: 'Thanks' } });
}

const audienceCard = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll('.audience-card')).find((el) => el.textContent?.includes(label)) as HTMLElement;

// The first audience card is the Newsletter, which asks for a blurb (or for help writing it)
function fillStep2(container: HTMLElement) {
  fireEvent.click(audienceCard(container, 'Newsletter'));
  fireEvent.click(screen.getByLabelText('Please write the blurb for me'));
  fireEvent.change(field(container, 'owner'), { target: { value: 'Test Member' } });
  fireEvent.change(field(container, 'replyToAddress'), { target: { value: 'replies@example.com' } });
}

async function clickNext(container: HTMLElement, expectedStep: number) {
  const next = screen.getByRole('button', { name: 'Next' });
  fireEvent.click(next);
  await waitFor(() => expect(activeStep(container)).toBe(expectedStep));
  return next;
}

async function goToStep3(container: HTMLElement) {
  // Let the approver/council fetches land first.
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/council\/members$/), expect.anything()));
  fillStep1(container);
  await clickNext(container, 2);
  fillStep2(container);
  return clickNext(container, 3);
}

async function pickSuggestion(container: HTMLElement, query: string, email: string) {
  const input = container.querySelector('.approver-input-wrap input') as HTMLInputElement;
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: query } });
  const item = await waitFor(() => {
    const el = Array.from(container.querySelectorAll('.approver-dropdown-item')).find((e) => e.textContent?.includes(email));
    expect(el).toBeTruthy();
    return el as HTMLElement;
  });
  fireEvent.mouseDown(item);
  await waitFor(() => expect(input.value).toBe(email));
  return input;
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });

const adminCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/admin/'));

describe('CommsRequest wizard', () => {
  it('Next validates the current step only, shows no errors before the user tries, and never submits', async () => {
    const { container } = renderForm();
    expect(container.querySelectorAll('.field-error')).toHaveLength(0);

    // Next on an empty step 1 stays on step 1 and shows step 1's errors, nothing from later steps.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('Subject line is required')).toBeInTheDocument());
    expect(activeStep(container)).toBe(1);
    expect(screen.queryByText('Owner is required')).not.toBeInTheDocument();

    fillStep1(container);
    await clickNext(container, 2);
    expect(screen.queryByText('Owner is required')).not.toBeInTheDocument();
    expect(screen.queryByText(/fill in all required fields/)).not.toBeInTheDocument();

    fillStep2(container);
    const next = await clickNext(container, 3);
    await settle();

    expect(screen.queryByText(APPROVER_ERROR)).not.toBeInTheDocument();
    expect(container.querySelectorAll('.field-error')).toHaveLength(0);
    expect(mockSaveSubmission).not.toHaveBeenCalled();
    // In a browser, React re-renders between the Next click's handler and the button's
    // default action; if the Submit button reused the Next button's node, that action
    // would submit the form. The node clicked must not become the submit control.
    const submit = screen.getByRole('button', { name: 'Submit Request' });
    expect(submit).not.toBe(next);
    expect(container.querySelector('form button[type="submit"]')).toBeNull();
  });

  it('a form submit event (Enter in a field) on steps 1 and 2 neither submits nor advances', async () => {
    const { container, form } = renderForm();
    fillStep1(container);
    fireEvent.submit(form);
    await settle();
    expect(activeStep(container)).toBe(1);
    expect(container.querySelectorAll('.field-error')).toHaveLength(0);

    await clickNext(container, 2);
    fillStep2(container);
    fireEvent.submit(form);
    await settle();
    expect(activeStep(container)).toBe(2);
    expect(container.querySelectorAll('.field-error')).toHaveLength(0);
    expect(mockSaveSubmission).not.toHaveBeenCalled();
  });

  it('choosing a suggestion adds the approver and makes no admin request', async () => {
    const { container } = renderForm();
    await goToStep3(container);
    await pickSuggestion(container, 'Pat', 'pat@example.com');
    await settle();
    expect(adminCalls()).toEqual([]);
    expect(fetchMock.mock.calls.some(([, init]) => init && (init as RequestInit).method === 'PUT')).toBe(false);
  });

  it('final Submit posts the submission once, with the chosen approver', async () => {
    const { container } = renderForm();
    await goToStep3(container);
    await pickSuggestion(container, 'Pat', 'pat@example.com');

    const submit = screen.getByRole('button', { name: 'Submit Request' });
    fireEvent.click(submit);
    fireEvent.click(submit); // a double click must not create two submissions
    await waitFor(() => expect(screen.getByText('Request Submitted!')).toBeInTheDocument());

    expect(mockSaveSubmission).toHaveBeenCalledTimes(1);
    const sent = mockSaveSubmission.mock.calls[0][0];
    expect(sent.requiredApprovers).toEqual(['pat@example.com']);
    expect(sent.title).toBe('Subject');
    expect(adminCalls()).toEqual([]);
  });

  it('Submit without an approver shows the approver error and does not post', async () => {
    const { container } = renderForm();
    await goToStep3(container);
    fireEvent.click(screen.getByRole('button', { name: 'Submit Request' }));
    await waitFor(() => expect(screen.getByText(APPROVER_ERROR)).toBeInTheDocument());
    expect(mockSaveSubmission).not.toHaveBeenCalled();
  });

  it('a failed save tells the user instead of failing silently', async () => {
    mockSaveSubmission.mockRejectedValue(new Error('Failed to save submission: 500'));
    const { container } = renderForm();
    await goToStep3(container);
    await pickSuggestion(container, 'Pat', 'pat@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Submit Request' }));
    await waitFor(() => expect(screen.getByText(/could not be submitted/i)).toBeInTheDocument());
    expect(screen.queryByText('Request Submitted!')).not.toBeInTheDocument();
  });

  it('shows the newsletter item only for the Newsletter audience, and needs a blurb or a request for help', async () => {
    const { container } = renderForm();
    fillStep1(container);
    await clickNext(container, 2);
    expect(screen.queryByLabelText('Newsletter item')).not.toBeInTheDocument();

    fireEvent.click(audienceCard(container, 'Newsletter'));
    expect(screen.getByLabelText('Newsletter item')).toBeInTheDocument();
    fireEvent.change(field(container, 'owner'), { target: { value: 'Test Member' } });
    fireEvent.change(field(container, 'replyToAddress'), { target: { value: 'replies@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText(/write a short blurb/)).toBeInTheDocument());
    expect(activeStep(container)).toBe(2);

    // "My full announcement" needs text, or a request for help with it
    const fullAnnouncement = screen.getByLabelText(/My full announcement/) as HTMLInputElement;
    expect(fullAnnouncement.disabled).toBe(true);

    // Without the newsletter, nothing about it is needed
    fireEvent.click(audienceCard(container, 'Newsletter'));
    fireEvent.click(audienceCard(container, 'Allcom'));
    expect(screen.queryByLabelText('Newsletter item')).not.toBeInTheDocument();
    await clickNext(container, 3);
  });

  it('sends the audience keys, the newsletter item, writing help and key dates', async () => {
    const { container } = renderForm();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/council\/members$/), expect.anything()));
    fillStep1(container);
    fireEvent.click(screen.getByLabelText('Please help me write this'));
    await clickNext(container, 2);
    fillStep2(container);
    fireEvent.click(audienceCard(container, 'Singular'));
    fireEvent.change(screen.getByLabelText('Newsletter headline'), { target: { value: '  Join the Operators!  ' } });
    fireEvent.click(screen.getByLabelText(/My full announcement/));
    fireEvent.click(screen.getByRole('button', { name: '+ Add a link' }));
    fireEvent.change(screen.getByLabelText('Link 1 text'), { target: { value: 'Operator shifts' } });
    fireEvent.change(screen.getByLabelText('Link 1 address'), { target: { value: 'https://example.org/shifts' } });

    // A key date with a bad link stops Next with a message
    fireEvent.click(screen.getByRole('button', { name: '+ Add a date' }));
    fireEvent.change(screen.getByLabelText('Key date 1'), { target: { value: '2026-08-15' } });
    fireEvent.change(screen.getByLabelText('Key date 1 description'), { target: { value: 'Perimeter training' } });
    fireEvent.change(screen.getByLabelText('Key date 1 link'), { target: { value: 'example.org' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText(/Key date 1: the link must start with https/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Key date 1 link'), { target: { value: '' } });
    await clickNext(container, 3);

    await pickSuggestion(container, 'Pat', 'pat@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Submit Request' }));
    await waitFor(() => expect(mockSaveSubmission).toHaveBeenCalledTimes(1));
    const sent = mockSaveSubmission.mock.calls[0][0];
    expect(sent.audiences).toEqual(['newsletter', 'singular']);
    expect(sent.writingHelp).toEqual({ document: true, blurb: true });
    expect(sent.newsletter).toEqual({
      headline: 'Join the Operators!',
      photos: [],
      links: [{ label: 'Operator shifts', url: 'https://example.org/shifts' }],
      readMore: { kind: 'document' },
    });
    expect(sent.keyDates).toEqual([{ date: '2026-08-15', label: 'Perimeter training' }]);
  });

  it('leaves the newsletter item out when the Newsletter is not an audience', async () => {
    const { container } = renderForm();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/council\/members$/), expect.anything()));
    fillStep1(container);
    await clickNext(container, 2);
    fireEvent.click(audienceCard(container, 'Allcom'));
    fireEvent.change(field(container, 'owner'), { target: { value: 'Test Member' } });
    fireEvent.change(field(container, 'replyToAddress'), { target: { value: 'replies@example.com' } });
    await clickNext(container, 3);
    await pickSuggestion(container, 'Pat', 'pat@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Submit Request' }));
    await waitFor(() => expect(mockSaveSubmission).toHaveBeenCalledTimes(1));
    const sent = mockSaveSubmission.mock.calls[0][0];
    expect(sent.audiences).toEqual(['allcom']);
    expect(sent.newsletter).toBeUndefined();
    expect(sent.writingHelp).toBeUndefined();
    expect(sent.keyDates).toBeUndefined();
  });
});

/** YYYY-MM-DD `days` from today, in local time (as the form computes it). */
const ymdFromToday = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const urgentBox = () => screen.getByLabelText('This is an urgent request') as HTMLInputElement;
const publishByInput = () => screen.getByPlaceholderText('Select a date') as HTMLInputElement;
const setPublishBy = (ymd: string) => fireEvent.change(publishByInput(), { target: { value: ymd } });
const URGENT_HELP = /require less than a week's turnaround/;

function seedDraft(extra: Record<string, unknown>) {
  localStorage.setItem('commsRequestDraft', JSON.stringify({
    suggestedSubjectLine: 'Subject',
    description: 'Description',
    signatureText: 'Thanks',
    audience: ['allcom'],
    owner: 'Test Member',
    replyToAddress: 'replies@example.com',
    ...extra,
  }));
}

async function toStep2FromDraft(container: HTMLElement) {
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/council\/members$/), expect.anything()));
  await waitFor(() => expect(field(container, 'suggestedSubjectLine').value).toBe('Subject'));
  await clickNext(container, 2);
}

describe('CommsRequest urgent flag', () => {
  it('a restored draft made urgent by its date stops being urgent when Publish By moves out of the week', async () => {
    seedDraft({ publishBy: ymdFromToday(3), urgentRequest: true });
    const { container } = renderForm();
    await toStep2FromDraft(container);
    expect(urgentBox().checked).toBe(true);
    expect(screen.getByText('Urgent')).toBeInTheDocument();

    setPublishBy(ymdFromToday(42));
    await waitFor(() => expect(publishByInput().value).toBe(ymdFromToday(42)));
    expect(urgentBox().checked).toBe(false);
    expect(screen.queryByText(URGENT_HELP)).not.toBeInTheDocument();
    expect(screen.queryByText('Urgent')).not.toBeInTheDocument();

    await clickNext(container, 3);
    await pickSuggestion(container, 'Pat', 'pat@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Submit Request' }));
    await waitFor(() => expect(mockSaveSubmission).toHaveBeenCalledTimes(1));
    const sent = mockSaveSubmission.mock.calls[0][0];
    expect(sent.formFields.find((f: any) => f.id === 'urgentRequest').value).toBe('No');
    expect(sent.formFields.find((f: any) => f.id === 'publishBy').value).toBe(ymdFromToday(42));
  });

  it('picking a date in the next week turns urgent on, and moving it out turns it off again', async () => {
    const { container } = renderForm();
    fillStep1(container);
    await clickNext(container, 2);
    expect(urgentBox().checked).toBe(false);
    setPublishBy(ymdFromToday(3));
    await waitFor(() => expect(urgentBox().checked).toBe(true));
    expect(screen.getByText(URGENT_HELP)).toBeInTheDocument();
    setPublishBy(ymdFromToday(30));
    await waitFor(() => expect(urgentBox().checked).toBe(false));
    expect(screen.queryByText(URGENT_HELP)).not.toBeInTheDocument();
  });

  it('urgent the person ticked themselves stays on whatever the date', async () => {
    const { container } = renderForm();
    fillStep1(container);
    await clickNext(container, 2);
    fireEvent.click(urgentBox());
    expect(urgentBox().checked).toBe(true);
    setPublishBy(ymdFromToday(3));
    await waitFor(() => expect(publishByInput().value).toBe(ymdFromToday(3)));
    setPublishBy(ymdFromToday(30));
    await waitFor(() => expect(publishByInput().value).toBe(ymdFromToday(30)));
    expect(urgentBox().checked).toBe(true);
  });

  it('a draft that saved urgent as the person\'s own choice keeps it when the date moves out', async () => {
    seedDraft({ publishBy: ymdFromToday(3), urgentRequest: true, urgentAuto: false });
    const { container } = renderForm();
    await toStep2FromDraft(container);
    expect(urgentBox().checked).toBe(true);
    setPublishBy(ymdFromToday(42));
    await waitFor(() => expect(publishByInput().value).toBe(ymdFromToday(42)));
    expect(urgentBox().checked).toBe(true);
  });

  it('a restored draft whose urgent date has since passed stays urgent', async () => {
    seedDraft({ publishBy: ymdFromToday(-1), urgentRequest: true, urgentAuto: true });
    const { container } = renderForm();
    await toStep2FromDraft(container);
    await settle();
    expect(urgentBox().checked).toBe(true);
  });

  it('the draft remembers that urgent came from the date, so after a reload moving the date out unticks it', async () => {
    const first = renderForm();
    fillStep1(first.container);
    await clickNext(first.container, 2);
    setPublishBy(ymdFromToday(3));
    await waitFor(() => expect(urgentBox().checked).toBe(true));
    const savedDraft = () => JSON.parse(localStorage.getItem('commsRequestDraft') || '{}');
    await waitFor(() => expect(savedDraft()).toMatchObject({ urgentRequest: true, urgentAuto: true }), { timeout: 3000 });
    first.unmount();

    const { container } = renderForm();
    await toStep2FromDraft(container);
    expect(urgentBox().checked).toBe(true);
    setPublishBy(ymdFromToday(30));
    await waitFor(() => expect(urgentBox().checked).toBe(false));
  });

  it('unticking urgent while the date is in the next week moves the date out to a week', async () => {
    const { container } = renderForm();
    fillStep1(container);
    await clickNext(container, 2);
    setPublishBy(ymdFromToday(3));
    await waitFor(() => expect(urgentBox().checked).toBe(true));
    fireEvent.click(urgentBox());
    await waitFor(() => expect(publishByInput().value).toBe(ymdFromToday(7)));
    expect(urgentBox().checked).toBe(false);
  });
});

describe('CommsRequest after a successful submit', () => {
  const bodyEditor = () => screen.getByLabelText('Start typing or paste your content...') as HTMLTextAreaElement;
  const blurbEditor = () => screen.getByLabelText(/^e\.g\. Everyone camping/) as HTMLTextAreaElement;

  async function submitAt3(container: HTMLElement) {
    await clickNext(container, 3);
    await pickSuggestion(container, 'Pat', 'pat@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Submit Request' }));
    await waitFor(() => expect(screen.getByText('Request Submitted!')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(activeStep(container)).toBe(1));
  }

  it('clears the text editor, the blurb editor and the dates, and the next request sends no old text', async () => {
    const { container } = renderForm();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/council\/members$/), expect.anything()));
    fillStep1(container);
    fireEvent.change(bodyEditor(), { target: { value: 'Hello Rangers! Training is on September 5, 2027.' } });
    await clickNext(container, 2);
    await waitFor(() => expect(screen.getByText('Dates in this request')).toBeInTheDocument());
    fireEvent.click(audienceCard(container, 'Newsletter'));
    // RichTextField takes the editor's first report as the loaded content, and only counts
    // edits after a key press
    fireEvent.keyDown(blurbEditor(), { key: 'O' });
    fireEvent.change(blurbEditor(), { target: { value: 'O' } });
    fireEvent.change(blurbEditor(), { target: { value: 'Old blurb' } });
    fireEvent.change(field(container, 'owner'), { target: { value: 'Test Member' } });
    fireEvent.change(field(container, 'replyToAddress'), { target: { value: 'replies@example.com' } });
    await submitAt3(container);

    const first = mockSaveSubmission.mock.calls[0][0];
    expect(first.richTextContent).toContain('Hello Rangers!');
    expect(first.newsletter.blurb).toContain('Old blurb');

    // The form is empty again, the editors included
    expect(field(container, 'suggestedSubjectLine').value).toBe('');
    expect(bodyEditor().value).toBe('');

    fillStep1(container);
    await clickNext(container, 2);
    expect(screen.queryByText('Dates in this request')).not.toBeInTheDocument();
    fireEvent.click(audienceCard(container, 'Newsletter'));
    expect(blurbEditor().value).toBe('');
    fireEvent.click(audienceCard(container, 'Newsletter'));
    fireEvent.click(audienceCard(container, 'Allcom'));
    fireEvent.change(field(container, 'owner'), { target: { value: 'Test Member' } });
    fireEvent.change(field(container, 'replyToAddress'), { target: { value: 'replies@example.com' } });
    await submitAt3(container);

    expect(mockSaveSubmission).toHaveBeenCalledTimes(2);
    const second = mockSaveSubmission.mock.calls[1][0];
    expect(second.richTextContent || '').not.toContain('Hello Rangers!');
    expect(second.content || '').not.toContain('Hello Rangers!');
  });

  it('a request started from a past message does not bring that message back after it is sent', async () => {
    const SOURCE = {
      id: 'past-1',
      title: 'Last year',
      formFields: [],
      richTextContent: JSON.stringify({ root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Copied body' }] }] } }),
    };
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/user/approvers')) return jsonResponse({ users: APPROVERS });
      if (url.endsWith('/council/members')) return jsonResponse(COUNCIL);
      if (url.endsWith('/content/submissions/past-1')) return jsonResponse(SOURCE);
      return jsonResponse({ error: 'forbidden' }, 403);
    });
    const { container } = renderForm('/comms-request?from=past-1&entry=entry-1');
    await waitFor(() => expect(bodyEditor().value).toBe('Copied body'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/council\/members$/), expect.anything()));
    fillStep1(container);
    await clickNext(container, 2);
    fireEvent.click(audienceCard(container, 'Allcom'));
    fireEvent.change(field(container, 'owner'), { target: { value: 'Test Member' } });
    fireEvent.change(field(container, 'replyToAddress'), { target: { value: 'replies@example.com' } });
    await submitAt3(container);
    expect(mockSaveSubmission.mock.calls[0][0].copiedFrom).toBe('past-1');

    expect(bodyEditor().value).toBe('');
    fillStep1(container);
    await clickNext(container, 2);
    fireEvent.click(audienceCard(container, 'Allcom'));
    fireEvent.change(field(container, 'owner'), { target: { value: 'Test Member' } });
    fireEvent.change(field(container, 'replyToAddress'), { target: { value: 'replies@example.com' } });
    await submitAt3(container);
    const second = mockSaveSubmission.mock.calls[1][0];
    expect(second.richTextContent || '').not.toContain('Copied body');
    expect(second.copiedFrom).toBeUndefined();
    expect(second.calendarEntryId).toBeUndefined();
  });
});
