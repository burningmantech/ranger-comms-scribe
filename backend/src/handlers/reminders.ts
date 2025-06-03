import { Router } from 'itty-router';
import { Reminder, User } from '../types';
import { withAuth } from '../authWrappers';

const router = Router();

// Get pending reminders for a user
router.get('/reminders', withAuth, async (request: Request, env: any) => {
  const user = (request as any).user as User;
  const reminders = await env.DB.prepare(
    'SELECT * FROM reminders WHERE approverId = ? AND status = ? AND nextSendAt <= ?'
  ).bind(user.id, 'pending', new Date().toISOString()).all();

  return new Response(JSON.stringify(reminders.results), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// Create a new reminder
router.post('/reminders', withAuth, async (request: Request, env: any) => {
  const reminder: Partial<Reminder> = await request.json();
  
  const newReminder: Reminder = {
    id: crypto.randomUUID(),
    submissionId: reminder.submissionId!,
    approverId: reminder.approverId!,
    lastSentAt: new Date().toISOString(),
    nextSendAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours from now
    status: 'pending'
  };

  await env.DB.prepare(
    'INSERT INTO reminders (id, submissionId, approverId, lastSentAt, nextSendAt, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(
    newReminder.id,
    newReminder.submissionId,
    newReminder.approverId,
    newReminder.lastSentAt,
    newReminder.nextSendAt,
    newReminder.status
  ).run();

  return new Response(JSON.stringify(newReminder), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// Update reminder status
router.put('/reminders/:id', withAuth, async (request: Request, env: any) => {
  const { id } = (request as any).params;
  const { status } = await request.json();
  const user = (request as any).user as User;

  const reminder = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(id).first();
  if (!reminder) {
    return new Response('Reminder not found', { status: 404 });
  }

  if (reminder.approverId !== user.id) {
    return new Response('Unauthorized', { status: 401 });
  }

  await env.DB.prepare(
    'UPDATE reminders SET status = ? WHERE id = ?'
  ).bind(status, id).run();

  return new Response(null, { status: 204 });
});

// Scheduled function to send reminders (runs daily)
export async function sendReminders(env: any) {
  const pendingReminders = await env.DB.prepare(
    'SELECT * FROM reminders WHERE status = ? AND nextSendAt <= ?'
  ).bind('pending', new Date().toISOString()).all();

  for (const reminder of pendingReminders.results) {
    const submission = await env.DB.prepare(
      'SELECT * FROM content_submissions WHERE id = ?'
    ).bind(reminder.submissionId).first();

    const approver = await env.DB.prepare(
      'SELECT * FROM users WHERE id = ?'
    ).bind(reminder.approverId).first();

    if (submission && approver) {
      // Send reminder email
      await env.EMAIL.send({
        to: approver.email,
        subject: `Reminder: Pending Approval for ${submission.title}`,
        text: `You have a pending approval for the following content:\n\nTitle: ${submission.title}\nContent: ${submission.content}\n\nPlease review and take action.`
      });

      // Update reminder
      await env.DB.prepare(
        'UPDATE reminders SET lastSentAt = ?, nextSendAt = ?, status = ? WHERE id = ?'
      ).bind(
        new Date().toISOString(),
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        'sent',
        reminder.id
      ).run();
    }
  }
}

export default router; 