import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { User } from '../types';
import { withAuth } from '../authWrappers';
import { Env } from '../utils/sessionManager';
import { getClientIp } from '../utils/clientIp';
import { FeedbackError, createFeedback, feedbackEnabledFor } from '../services/feedbackService';

/**
 * The feedback tab (services/feedbackService.ts). Admin → Feedback and the switches are under
 * /api/admin (handlers/admin.ts).
 */
export const router = AutoRouter({ base: '/api/feedback' });

const userOf = (request: Request) => (request as any).user as User;

// Whether the signed-in person sees the feedback tab (read live, so a switch takes effect without signing in again)
router.get('/config', withAuth, async (request: Request, env: Env) => {
  return json({ enabled: await feedbackEnabledFor(userOf(request), env) });
});

// Send feedback: { message, url, screenshot?: JPEG data URL, diagnostics }
router.post('/', withAuth, async (request: Request, env: Env) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Send the feedback as JSON' }, { status: 400 });
  }
  try {
    const report = await createFeedback(body || {}, userOf(request), env, getClientIp(request) || undefined);
    return json({ id: report.id, emailed: report.emailedTo.length > 0 }, { status: 201 });
  } catch (err) {
    if (err instanceof FeedbackError) return json({ error: err.message }, { status: err.status });
    console.error('Feedback failed:', err);
    return json({ error: 'Something went wrong' }, { status: 500 });
  }
});
