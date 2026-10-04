import { AutoRouter } from 'itty-router';
import { SubmissionTemplate } from '../types';
import { Env } from '../utils/sessionManager';
import { getObject, putObject, deleteObject, listObjects } from '../services/cacheService';
import { withAuth } from '../authWrappers';

const TEMPLATES_PREFIX = 'templates/';

export const router = AutoRouter({ base: '/api/templates' });

// GET /api/templates — public list of active templates (authenticated users)
router.get('/', withAuth, async (request: Request, env: Env) => {
  const templates = await getAllTemplates(env);
  const active = templates
    .filter(t => t.active)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  return new Response(JSON.stringify(active), {
    headers: { 'Content-Type': 'application/json' },
  });
});

// GET /api/templates/admin — list all templates (admin only)
router.get('/admin', withAuth, async (request: Request, env: Env) => {
  const user = (request as any).user;
  if (user.userType !== 'Admin') {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const templates = await getAllTemplates(env);
  templates.sort((a, b) => a.sortOrder - b.sortOrder);
  return new Response(JSON.stringify(templates), {
    headers: { 'Content-Type': 'application/json' },
  });
});

// POST /api/templates — create template (admin only)
router.post('/', withAuth, async (request: Request, env: Env) => {
  const user = (request as any).user;
  if (user.userType !== 'Admin') {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await request.json() as Partial<SubmissionTemplate>;
  if (!body.name) {
    return new Response(JSON.stringify({ error: 'Name is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const now = new Date().toISOString();
  const template: SubmissionTemplate = {
    id: crypto.randomUUID(),
    name: body.name,
    description: body.description || '',
    fields: body.fields || {},
    sortOrder: body.sortOrder ?? 0,
    active: body.active ?? true,
    createdBy: user.email,
    createdAt: now,
    updatedAt: now,
  };

  await putObject(`${TEMPLATES_PREFIX}${template.id}`, template, env);

  return new Response(JSON.stringify(template), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
});

// PUT /api/templates/:id — update template (admin only)
router.put('/:id', withAuth, async (request: Request, env: Env) => {
  const user = (request as any).user;
  if (user.userType !== 'Admin') {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { id } = (request as any).params;
  const existing = await getObject<SubmissionTemplate>(`${TEMPLATES_PREFIX}${id}`, env);
  if (!existing) {
    return new Response(JSON.stringify({ error: 'Template not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await request.json() as Partial<SubmissionTemplate>;
  const updated: SubmissionTemplate = {
    ...existing,
    name: body.name ?? existing.name,
    description: body.description ?? existing.description,
    fields: body.fields ?? existing.fields,
    sortOrder: body.sortOrder ?? existing.sortOrder,
    active: body.active ?? existing.active,
    updatedAt: new Date().toISOString(),
  };

  await putObject(`${TEMPLATES_PREFIX}${id}`, updated, env);

  return new Response(JSON.stringify(updated), {
    headers: { 'Content-Type': 'application/json' },
  });
});

// DELETE /api/templates/:id — delete template (admin only)
router.delete('/:id', withAuth, async (request: Request, env: Env) => {
  const user = (request as any).user;
  if (user.userType !== 'Admin') {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { id } = (request as any).params;
  const existing = await getObject<SubmissionTemplate>(`${TEMPLATES_PREFIX}${id}`, env);
  if (!existing) {
    return new Response(JSON.stringify({ error: 'Template not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  await deleteObject(`${TEMPLATES_PREFIX}${id}`, env);

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

async function getAllTemplates(env: Env): Promise<SubmissionTemplate[]> {
  const listing = await listObjects(TEMPLATES_PREFIX, env);
  if (!listing?.objects) return [];

  const templates: SubmissionTemplate[] = [];
  for (const obj of listing.objects) {
    const template = await getObject<SubmissionTemplate>(obj.key, env);
    if (template) templates.push(template);
  }
  return templates;
}
