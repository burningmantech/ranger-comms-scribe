import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { Env } from '../utils/sessionManager';
import { buildAnnouncementEmail } from '../services/announcementEmail';
import { getPublishedDocument, getSentEdition, listSentEditions } from '../services/newsletterService';

/**
 * Public, unlisted pages (no session): sent newsletter editions, their archive, and the
 * published "Read more" documents they link to. Only sent editions and published documents
 * are served; responses ask search engines not to index them.
 */
export const router = AutoRouter({ base: '/api/public' });

const NOINDEX = { 'X-Robots-Tag': 'noindex, nofollow' };

function withNoindexMeta(html: string): string {
  return html.replace('<head>', '<head><meta name="robots" content="noindex, nofollow">');
}

router.get('/newsletter', async (_request: Request, env: Env) => {
  return json({ editions: await listSentEditions(env) }, { headers: NOINDEX });
});

router.get('/newsletter/:number', async (request: Request, env: Env) => {
  const number = Number((request as any).params.number);
  const sent = await getSentEdition(number, env);
  if (!sent) return json({ error: 'Not found' }, { status: 404, headers: NOINDEX });
  return json({
    number: sent.number,
    subject: sent.subject,
    sentAt: sent.sentAt,
    html: withNoindexMeta(sent.html),
  }, { headers: NOINDEX });
});

router.get('/news/:slug', async (request: Request, env: Env) => {
  const submission = await getPublishedDocument(String((request as any).params.slug || ''), env);
  if (!submission) return json({ error: 'Not found' }, { status: 404, headers: NOINDEX });
  const email = await buildAnnouncementEmail(submission, env, { headline: true });
  return json({
    subject: email.subject,
    publishedAt: submission.publicPublishedAt,
    html: withNoindexMeta(email.html),
  }, { headers: NOINDEX });
});
