import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { User } from '../types';
import { withAuth } from '../authWrappers';
import { Env } from '../utils/sessionManager';
import { InputError } from '../utils/newsletterInput';
import {
  ServiceError,
  addComment,
  addSubmissionSection,
  approvalState,
  canManageNewsletter,
  createEdition,
  decideEdition,
  deleteEdition,
  editorCalendar,
  getEdition,
  getTray,
  listEditions,
  nextEditionNumber,
  overrideApproval,
  refreshSection,
  renderEdition,
  sectionSources,
  sendEdition,
  sendTestEdition,
  submitForApproval,
  updateEdition,
  documentPageUrl,
} from '../services/newsletterService';
import { isAdminUser, isCommsCadre, isCommsManager } from '../services/commsCadreService';
import { NewsletterEdition, ContentSubmission } from '../types';
import { getObject } from '../services/cacheService';

/**
 * Newsletter editions (Comms Cadre and Admins). Every route checks the session itself
 * (withAuth) as well as the /api/newsletter/* session check in index.ts, because tests call
 * this router directly.
 */
export const router = AutoRouter({ base: '/api/newsletter' });

const userOf = (request: Request) => (request as any).user as User;
const paramsOf = (request: Request) => (request as any).params as Record<string, string>;

async function bodyOf(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/** withAuth, then Comms Cadre or Admin. */
async function withNewsletterAccess(request: Request, env: Env) {
  const denied = await withAuth(request, env);
  if (denied) return denied;
  if (!(await canManageNewsletter(userOf(request), env))) {
    return json({ error: 'Only the Comms Cadre can work on the newsletter' }, { status: 403 });
  }
  return undefined;
}

function handle(work: (request: Request, env: Env) => Promise<Response>) {
  return async (request: Request, env: Env) => {
    try {
      return await work(request, env);
    } catch (err) {
      if (err instanceof ServiceError) return json({ error: err.message, ...err.body }, { status: err.status });
      if (err instanceof InputError) return json({ error: err.message }, { status: 400 });
      console.error('Newsletter request failed:', err);
      return json({ error: 'Something went wrong' }, { status: 500 });
    }
  };
}

/** An edition as the editor gets it: with its approval state, section sources and calendar. */
async function editionView(edition: NewsletterEdition, env: Env, user: User) {
  const documents: Record<string, { title: string; status: string; url: string | null }> = {};
  for (const section of edition.sections) {
    const id = section.readMore.kind === 'document' ? section.readMore.submissionId : undefined;
    if (!id || documents[id]) continue;
    const submission = await getObject<ContentSubmission>(`content_submissions/${id}`, env);
    documents[id] = {
      title: submission?.title || '(missing request)',
      status: submission?.status || 'missing',
      url: submission?.publicSlug ? documentPageUrl(env, submission.publicSlug) : null,
    };
  }
  return {
    edition,
    approval: approvalState(edition),
    sources: await sectionSources(edition, env),
    calendar: editorCalendar(edition),
    documents,
    permissions: {
      canApprove: await isCommsManager(user, env) || await isCommsCadre(user, env),
      canOverride: isAdminUser(user) || await isCommsManager(user, env),
      isCommsManager: await isCommsManager(user, env),
      announceConfigured: !!env.ANNOUNCE_EMAIL_TO,
    },
  };
}

router.get('/editions', withNewsletterAccess, handle(async (_request, env) => {
  const editions = await listEditions(env);
  return json({
    editions: editions.map((e) => ({
      id: e.id,
      number: e.number,
      subject: e.subject,
      status: e.status,
      sectionCount: e.sections.length,
      updatedAt: e.updatedAt,
      sentAt: e.sentAt,
      approval: approvalState(e),
    })),
    nextNumber: await nextEditionNumber(env, editions),
  });
}));

router.post('/editions', withNewsletterAccess, handle(async (request, env) => {
  const edition = await createEdition(await bodyOf(request), userOf(request), env);
  return json(await editionView(edition, env, userOf(request)), { status: 201 });
}));

router.get('/tray', withNewsletterAccess, handle(async (_request, env) => json(await getTray(env))));

router.get('/editions/:id', withNewsletterAccess, handle(async (request, env) => {
  const edition = await getEdition(paramsOf(request).id, env);
  if (!edition) return json({ error: 'Edition not found' }, { status: 404 });
  return json(await editionView(edition, env, userOf(request)));
}));

router.put('/editions/:id', withNewsletterAccess, handle(async (request, env) => {
  const edition = await updateEdition(paramsOf(request).id, await bodyOf(request), userOf(request), env);
  return json(await editionView(edition, env, userOf(request)));
}));

router.delete('/editions/:id', withNewsletterAccess, handle(async (request, env) => {
  await deleteEdition(paramsOf(request).id, env);
  return json({ success: true });
}));

router.post('/editions/:id/sections/from-submission', withNewsletterAccess, handle(async (request, env) => {
  const { submissionId } = await bodyOf(request);
  if (typeof submissionId !== 'string' || !submissionId) return json({ error: 'submissionId is required' }, { status: 400 });
  const edition = await addSubmissionSection(paramsOf(request).id, submissionId, userOf(request), env);
  return json(await editionView(edition, env, userOf(request)));
}));

router.post('/editions/:id/sections/:sectionId/refresh', withNewsletterAccess, handle(async (request, env) => {
  const { id, sectionId } = paramsOf(request);
  const edition = await refreshSection(id, sectionId, userOf(request), env);
  return json(await editionView(edition, env, userOf(request)));
}));

router.get('/editions/:id/preview', withNewsletterAccess, handle(async (request, env) => {
  const edition = await getEdition(paramsOf(request).id, env);
  if (!edition) return json({ error: 'Edition not found' }, { status: 404 });
  const email = await renderEdition(edition, env);
  return json({ ...email, to: env.ANNOUNCE_EMAIL_TO || null, replyTo: edition.replyTo || null, version: edition.version });
}));

router.post('/editions/:id/submit', withNewsletterAccess, handle(async (request, env) => {
  const edition = await submitForApproval(paramsOf(request).id, userOf(request), env);
  return json(await editionView(edition, env, userOf(request)));
}));

router.post('/editions/:id/approve', withNewsletterAccess, handle(async (request, env) => {
  const edition = await decideEdition(paramsOf(request).id, await bodyOf(request), userOf(request), env);
  return json(await editionView(edition, env, userOf(request)));
}));

router.post('/editions/:id/override-approve', withNewsletterAccess, handle(async (request, env) => {
  const edition = await overrideApproval(paramsOf(request).id, await bodyOf(request), userOf(request), env);
  return json(await editionView(edition, env, userOf(request)));
}));

router.post('/editions/:id/comments', withNewsletterAccess, handle(async (request, env) => {
  const { content } = await bodyOf(request);
  const edition = await addComment(paramsOf(request).id, content, userOf(request), env);
  return json(await editionView(edition, env, userOf(request)));
}));

router.post('/editions/:id/send-test', withNewsletterAccess, handle(async (request, env) => {
  return json(await sendTestEdition(paramsOf(request).id, userOf(request), env));
}));

router.post('/editions/:id/send', withNewsletterAccess, handle(async (request, env) => {
  const edition = await sendEdition(paramsOf(request).id, userOf(request), env);
  return json(await editionView(edition, env, userOf(request)));
}));
