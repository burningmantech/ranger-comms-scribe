import { AutoRouter } from 'itty-router';
import { AppNotification } from '../types';
import { Env } from '../utils/sessionManager';
import { getObject, putObject, listObjects } from '../services/cacheService';
import { withAuth } from '../authWrappers';

const NOTIFICATIONS_PREFIX = 'notifications/';

export const router = AutoRouter({ base: '/api/notifications' });

// GET /api/notifications — paginated list for current user
router.get('/', withAuth, async (request: Request, env: Env) => {
  const user = (request as any).user;
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') || '20');
  const offset = parseInt(url.searchParams.get('offset') || '0');

  const notifications = await getUserNotifications(user.email, env);
  notifications.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const paged = notifications.slice(offset, offset + limit);
  return new Response(JSON.stringify({
    notifications: paged,
    total: notifications.length,
    hasMore: offset + limit < notifications.length,
  }), { headers: { 'Content-Type': 'application/json' } });
});

// GET /api/notifications/unread-count — for badge
router.get('/unread-count', withAuth, async (request: Request, env: Env) => {
  const user = (request as any).user;
  const notifications = await getUserNotifications(user.email, env);
  const unreadCount = notifications.filter(n => !n.read).length;
  return new Response(JSON.stringify({ unreadCount }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

// PUT /api/notifications/read-all — mark all as read
router.put('/read-all', withAuth, async (request: Request, env: Env) => {
  const user = (request as any).user;
  const notifications = await getUserNotifications(user.email, env);

  for (const notif of notifications) {
    if (!notif.read) {
      notif.read = true;
      await putObject(`${NOTIFICATIONS_PREFIX}${user.email}/${notif.id}`, notif, env);
    }
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

// PUT /api/notifications/:id/read — mark single as read
router.put('/:id/read', withAuth, async (request: Request, env: Env) => {
  const user = (request as any).user;
  const { id } = (request as any).params;

  const notif = await getObject<AppNotification>(`${NOTIFICATIONS_PREFIX}${user.email}/${id}`, env);
  if (!notif) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  notif.read = true;
  await putObject(`${NOTIFICATIONS_PREFIX}${user.email}/${notif.id}`, notif, env);

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

async function getUserNotifications(userId: string, env: Env): Promise<AppNotification[]> {
  const listing = await listObjects(`${NOTIFICATIONS_PREFIX}${userId}/`, env);
  if (!listing?.objects) return [];

  const notifications: AppNotification[] = [];
  for (const obj of listing.objects) {
    const notif = await getObject<AppNotification>(obj.key, env);
    if (notif) notifications.push(notif);
  }
  return notifications;
}
