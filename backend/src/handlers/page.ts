import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { Env } from '../utils/sessionManager';
import { withAdminCheck, withAuthCheck } from '../authWrappers';
import {
  getPages,
  getAllPages,
  getPage,
  getPageBySlug,
  createPage,
  updatePage,
  deletePage,
  reorderPages,
  getHomePageContent
} from '../services/pageService';

// Extend the Request interface to include user and params properties
interface ExtendedRequest extends Request {
  user?: string;
  userName?: string;
  params: Record<string, string>;
}

export const router = AutoRouter({ base: '/page' });

// Get all published pages (public route)
router.get('/', async (request: ExtendedRequest, env: Env) => {
  try {
    console.log('GET /page called');
    const userId = request.user;
    const pages = await getPages(env, userId);
    return json(pages);
  } catch (error) {
    console.error('Error fetching pages:', error);
    return json({ error: 'Error fetching pages' }, { status: 500 });
  }
});

// Get all pages including unpublished (admin only)
router.get('/all', withAdminCheck, async (request: ExtendedRequest, env: Env) => {
  try {
    console.log('GET /page/all called');
    const pages = await getAllPages(env);
    return json(pages);
  } catch (error) {
    console.error('Error fetching all pages:', error);
    return json({ error: 'Error fetching all pages' }, { status: 500 });
  }
});

// Get a single page by ID
router.get('/id/:id', async (request: ExtendedRequest, env: Env) => {
  try {
    const { id } = request.params;
    console.log(`GET /page/id/${id} called`);
    
    const page = await getPage(id, env);
    if (!page) {
      return json({ error: 'Page not found' }, { status: 404 });
    }
    
    // Check if user has access to this page
    if (!page.published && !request.user) {
      return json({ error: 'Page not found' }, { status: 404 });
    }
    
    if (!page.isPublic && !request.user) {
      return json({ error: 'Page not found' }, { status: 404 });
    }
    
    return json(page);
  } catch (error) {
    console.error('Error fetching page:', error);
    return json({ error: 'Error fetching page' }, { status: 500 });
  }
});

// Get a single page by slug
router.get('/:slug', async (request: ExtendedRequest, env: Env) => {
  try {
    const { slug } = request.params;
    console.log(`GET /page/${slug} called`);
    
    const page = await getPageBySlug(slug, env);
    if (!page) {
      return json({ error: 'Page not found' }, { status: 404 });
    }
    
    // Check if user has access to this page
    if (!page.published && !request.user) {
      return json({ error: 'Page not found' }, { status: 404 });
    }
    
    if (!page.isPublic && !request.user) {
      return json({ error: 'Page not found' }, { status: 404 });
    }
    
    return json(page);
  } catch (error) {
    console.error('Error fetching page:', error);
    return json({ error: 'Error fetching page' }, { status: 500 });
  }
});

// Create a new page (admin only)
router.post('/', withAdminCheck, async (request: ExtendedRequest, env: Env) => {
  try {
    console.log('POST /page called');
    
    if (!request.user) {
      return json({ error: 'User not authenticated' }, { status: 401 });
    }
    
    const { 
      title, 
      slug, 
      content, 
      published, 
      isPublic, 
      groupId, 
      order,
      showInNavigation,
      parentPageId,
      isHome
    } = await request.json() as {
      title: string;
      slug: string;
      content: string;
      published?: boolean;
      isPublic?: boolean;
      groupId?: string;
      order?: number;
      showInNavigation?: boolean;
      parentPageId?: string;
      isHome?: boolean;
    };
    
    if (!title || !slug || !content) {
      return json({ error: 'Title, slug, and content are required' }, { status: 400 });
    }
    
    // Get user name from session
    const userKey = `user/${request.user}`;
    const userObject = await env.R2.get(userKey);
    let userName = 'Admin';
    
    if (userObject) {
      const userData = await userObject.json() as { name?: string };
      if (userData.name) {
        userName = userData.name;
      }
    }
    
    const result = await createPage(
      { 
        title, 
        slug, 
        content, 
        published, 
        isPublic, 
        groupId, 
        order,
        showInNavigation,
        parentPageId,
        isHome
      },
      request.user,
      userName,
      env
    );
    
    if (result.success) {
      return json(result, { status: 201 });
    } else {
      return json(result, { status: 400 });
    }
  } catch (error) {
    console.error('Error creating page:', error);
    return json({ error: 'Error creating page' }, { status: 500 });
  }
});

// Update a page (admin only)
router.put('/:id', withAdminCheck, async (request: ExtendedRequest, env: Env) => {
  try {
    const { id } = request.params;
    console.log(`PUT /page/${id} called`);
    
    const updates = await request.json() as {
      title?: string;
      slug?: string;
      content?: string;
      published?: boolean;
      isPublic?: boolean;
      groupId?: string;
      order?: number;
      showInNavigation?: boolean;
      parentPageId?: string;
      isHome?: boolean;
    };
    
    const result = await updatePage(id, updates, env);
    
    if (result.success) {
      return json(result);
    } else {
      return json(result, { status: 404 });
    }
  } catch (error) {
    console.error('Error updating page:', error);
    return json({ error: 'Error updating page' }, { status: 500 });
  }
});

// Delete a page (admin only)
router.delete('/:id', withAdminCheck, async (request: ExtendedRequest, env: Env) => {
  try {
    const { id } = request.params;
    console.log(`DELETE /page/${id} called`);
    
    const result = await deletePage(id, env);
    
    if (result.success) {
      return json(result);
    } else {
      return json(result, { status: 404 });
    }
  } catch (error) {
    console.error('Error deleting page:', error);
    return json({ error: 'Error deleting page' }, { status: 500 });
  }
});

// Reorder pages (admin only)
router.post('/reorder', withAdminCheck, async (request: ExtendedRequest, env: Env) => {
  try {
    console.log('POST /page/reorder called');
    
    const { pageOrders } = await request.json() as {
      pageOrders: { id: string; order: number }[];
    };
    
    if (!pageOrders || !Array.isArray(pageOrders) || pageOrders.length === 0) {
      return json({ error: 'Page orders are required' }, { status: 400 });
    }
    
    const result = await reorderPages(pageOrders, env);
    
    if (result.success) {
      return json(result);
    } else {
      return json(result, { status: 400 });
    }
  } catch (error) {
    console.error('Error reordering pages:', error);
    return json({ error: 'Error reordering pages' }, { status: 500 });
  }
});

// Get home page content
router.get('/home/content', async (request: Request, env: Env) => {
  try {
    console.log('GET /page/home/content called');
    
    const content = await getHomePageContent(env);
    
    if (content) {
      return json({ content });
    } else {
      return json({ content: null });
    }
  } catch (error) {
    console.error('Error fetching home page content:', error);
    return json({ error: 'Error fetching home page content' }, { status: 500 });
  }
});

// Set a page as the home page (admin only)
router.post('/:id/make-home', withAdminCheck, async (request: ExtendedRequest, env: Env) => {
  try {
    const { id } = request.params;
    console.log(`POST /page/${id}/make-home called`);
    
    // First, update all pages to not be home
    const allPages = await getAllPages(env);
    
    // Update each page's isHome property
    for (const page of allPages) {
      if (page.isHome && page.id !== id) {
        await updatePage(page.id, { isHome: false }, env);
      }
    }
    
    // Set the selected page as home
    const result = await updatePage(id, { isHome: true }, env);
    
    if (result.success) {
      return json({ success: true, message: 'Home page updated successfully' });
    } else {
      return json(result, { status: 404 });
    }
  } catch (error) {
    console.error('Error setting home page:', error);
    return json({ error: 'Error setting home page' }, { status: 500 });
  }
});
