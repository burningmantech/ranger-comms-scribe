import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CommsRequest from './CommsRequest';

const mockSaveSubmission = jest.fn();

jest.mock('../contexts/ContentContext', () => ({
  useContent: () => ({ saveSubmission: mockSaveSubmission }),
}));

jest.mock('./editor/LexicalEditor', () => {
  return function MockLexicalEditor() {
    return <div data-testid="lexical-editor" />;
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

function renderForm() {
  const utils = render(
    <MemoryRouter>
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

function fillStep2(container: HTMLElement) {
  fireEvent.click(container.querySelector('.audience-card') as HTMLElement);
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
});
