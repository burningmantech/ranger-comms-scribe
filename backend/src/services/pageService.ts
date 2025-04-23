import { Page } from '../types';
import { Env } from '../utils/sessionManager';
import { v4 as uuidv4 } from 'uuid';

// Get all pages
export async function getPages(env: Env, userId?: string): Promise<Page[]> {
  const pages: Page[] = [];
  
  try {
    // List all pages
    const pagesList = await env.R2.list({ prefix: 'page/' });
    
    // Process each page
    for (const page of pagesList.objects) {
      try {
        const pageObject = await env.R2.get(page.key);
        if (pageObject) {
          const pageData = await pageObject.json() as Page;
          
          // Filter based on visibility permissions
          if (pageData.published && (pageData.isPublic || userId)) {
            pages.push(pageData);
          }
        }
      } catch (error) {
        console.error(`Error processing page ${page.key}:`, error);
        // Continue processing other pages even if one fails
      }
    }
    
    // Sort pages by order
    return pages.sort((a, b) => a.order - b.order);
  } catch (error) {
    console.error('Error listing pages from R2:', error);
    return [];
  }
}

// Get all pages (admin version - includes unpublished)
export async function getAllPages(env: Env): Promise<Page[]> {
  const pages: Page[] = [];
  
  try {
    // List all pages
    const pagesList = await env.R2.list({ prefix: 'page/' });
    
    // Process each page
    for (const page of pagesList.objects) {
      try {
        const pageObject = await env.R2.get(page.key);
        if (pageObject) {
          const pageData = await pageObject.json() as Page;
          pages.push(pageData);
        }
      } catch (error) {
        console.error(`Error processing page ${page.key}:`, error);
        // Continue processing other pages even if one fails
      }
    }
    
    // Sort pages by order
    return pages.sort((a, b) => a.order - b.order);
  } catch (error) {
    console.error('Error listing all pages from R2:', error);
    return [];
  }
}

// Get a single page by ID
export async function getPage(id: string, env: Env): Promise<Page | null> {
  try {
    const pageKey = `page/${id}`;
    const pageObject = await env.R2.get(pageKey);
    
    if (!pageObject) {
      return null;
    }
    
    return await pageObject.json() as Page;
  } catch (error) {
    console.error(`Error fetching page ${id}:`, error);
    return null;
  }
}

// Get a single page by slug
export async function getPageBySlug(slug: string, env: Env): Promise<Page | null> {
  try {
    // List all pages
    const pagesList = await env.R2.list({ prefix: 'page/' });
    
    // Find the page with the matching slug
    for (const page of pagesList.objects) {
      const pageObject = await env.R2.get(page.key);
      if (pageObject) {
        const pageData = await pageObject.json() as Page;
        if (pageData.slug === slug) {
          return pageData;
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error(`Error fetching page by slug ${slug}:`, error);
    return null;
  }
}

// Create a new page
export async function createPage(
  pageData: {
    title: string;
    slug: string;
    content: string;
    published?: boolean;
    isPublic?: boolean;
    groupId?: string;
    order?: number;
    showInNavigation?: boolean;
  },
  userId: string,
  userName: string,
  env: Env
): Promise<{ success: boolean; page?: Page; error?: string }> {
  try {
    // Validate slug format (alphanumeric, hyphens, no spaces)
    const slugRegex = /^[a-z0-9-]+$/;
    if (!slugRegex.test(pageData.slug)) {
      return { 
        success: false, 
        error: 'Slug must contain only lowercase letters, numbers, and hyphens' 
      };
    }
    
    // Check if slug already exists
    const existingPage = await getPageBySlug(pageData.slug, env);
    if (existingPage) {
      return { 
        success: false, 
        error: 'A page with this slug already exists' 
      };
    }
    
    // Get the highest order value to place this page at the end
    let highestOrder = 0;
    const allPages = await getAllPages(env);
    if (allPages.length > 0) {
      highestOrder = Math.max(...allPages.map(p => p.order));
    }
    
    const now = new Date().toISOString();
    const pageId = uuidv4();
    
    const newPage: Page = {
      id: pageId,
      title: pageData.title,
      slug: pageData.slug,
      content: pageData.content,
      createdBy: userName,
      createdAt: now,
      updatedAt: now,
      published: pageData.published ?? false,
      isPublic: pageData.isPublic ?? true,
      groupId: pageData.groupId,
      order: pageData.order ?? highestOrder + 10, // Default to end of list with spacing for manual reordering
      showInNavigation: pageData.showInNavigation ?? true
    };
    
    // Save the page
    const pageKey = `page/${pageId}`;
    await env.R2.put(pageKey, JSON.stringify(newPage));
    
    return { success: true, page: newPage };
  } catch (error) {
    console.error('Error creating page:', error);
    return { 
      success: false, 
      error: (error as Error).message || 'Error creating page' 
    };
  }
}

// Update a page
export async function updatePage(
  id: string,
  updates: {
    title?: string;
    slug?: string;
    content?: string;
    published?: boolean;
    isPublic?: boolean;
    groupId?: string;
    order?: number;
    showInNavigation?: boolean;
    isHome?: boolean;
  },
  env: Env
): Promise<{ success: boolean; page?: Page; error?: string }> {
  try {
    // Get the existing page
    const pageKey = `page/${id}`;
    const pageObject = await env.R2.get(pageKey);
    
    if (!pageObject) {
      return { success: false, error: 'Page not found' };
    }
    
    const existingPage = await pageObject.json() as Page;
    
    // Check if slug is being updated and validate it
    if (updates.slug && updates.slug !== existingPage.slug) {
      // Validate slug format
      const slugRegex = /^[a-z0-9-]+$/;
      if (!slugRegex.test(updates.slug)) {
        return { 
          success: false, 
          error: 'Slug must contain only lowercase letters, numbers, and hyphens' 
        };
      }
      
      // Check if new slug already exists
      const existingPageWithSlug = await getPageBySlug(updates.slug, env);
      if (existingPageWithSlug && existingPageWithSlug.id !== id) {
        return { 
          success: false, 
          error: 'A page with this slug already exists' 
        };
      }
    }
    
    // Update the page
    const updatedPage: Page = {
      ...existingPage,
      title: updates.title ?? existingPage.title,
      slug: updates.slug ?? existingPage.slug,
      content: updates.content ?? existingPage.content,
      published: updates.published !== undefined ? updates.published : existingPage.published,
      isPublic: updates.isPublic !== undefined ? updates.isPublic : existingPage.isPublic,
      groupId: updates.groupId !== undefined ? updates.groupId : existingPage.groupId,
      order: updates.order !== undefined ? updates.order : existingPage.order,
      showInNavigation: updates.showInNavigation !== undefined ? updates.showInNavigation : existingPage.showInNavigation,
      isHome: updates.isHome !== undefined ? updates.isHome : existingPage.isHome,
      updatedAt: new Date().toISOString()
    };
    
    // Save the updated page
    await env.R2.put(pageKey, JSON.stringify(updatedPage));
    
    return { success: true, page: updatedPage };
  } catch (error) {
    console.error(`Error updating page ${id}:`, error);
    return { 
      success: false, 
      error: (error as Error).message || 'Error updating page' 
    };
  }
}

// Delete a page
export async function deletePage(
  id: string,
  env: Env
): Promise<{ success: boolean; error?: string }> {
  try {
    // Check if page exists
    const pageKey = `page/${id}`;
    const pageObject = await env.R2.get(pageKey);
    
    if (!pageObject) {
      return { success: false, error: 'Page not found' };
    }
    
    // Delete the page
    await env.R2.delete(pageKey);
    
    return { success: true };
  } catch (error) {
    console.error(`Error deleting page ${id}:`, error);
    return { 
      success: false, 
      error: (error as Error).message || 'Error deleting page' 
    };
  }
}

// Reorder pages
export async function reorderPages(
  pageOrders: { id: string; order: number }[],
  env: Env
): Promise<{ success: boolean; error?: string }> {
  try {
    // Update each page's order
    for (const { id, order } of pageOrders) {
      const result = await updatePage(id, { order }, env);
      if (!result.success) {
        return { success: false, error: `Failed to update order for page ${id}: ${result.error}` };
      }
    }
    
    return { success: true };
  } catch (error) {
    console.error('Error reordering pages:', error);
    return { 
      success: false, 
      error: (error as Error).message || 'Error reordering pages' 
    };
  }
}

// Get the home page content
export async function getHomePageContent(env: Env): Promise<string | null> {
  try {
    // Try to get the home page by slug
    const homePage = await getPageBySlug('home', env);
    
    if (homePage && homePage.published) {
      return homePage.content;
    }
    
    return null;
  } catch (error) {
    console.error('Error fetching home page content:', error);
    return null;
  }
}
