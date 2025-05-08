import { Page } from '../types';
import { Env } from '../utils/sessionManager';
import { v4 as uuidv4 } from 'uuid';
import { getObject, putObject, deleteObject, listObjects } from './cacheService';

// Get all pages
export async function getPages(env: Env, userId?: string): Promise<Page[]> {
  const pages: Page[] = [];
  
  try {
    // List all pages using cacheService
    const pagesList = await listObjects('page/', env);
    
    // Process each page
    for (const page of pagesList.objects) {
      try {
        const pageData = await getObject<Page>(page.key, env);
        if (pageData) {
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
    console.error('Error listing pages:', error);
    return [];
  }
}

// Get all pages (admin version - includes unpublished)
export async function getAllPages(env: Env): Promise<Page[]> {
  const pages: Page[] = [];
  
  try {
    // List all pages using cacheService
    const pagesList = await listObjects('page/', env);
    
    // Process each page
    for (const page of pagesList.objects) {
      try {
        const pageData = await getObject<Page>(page.key, env);
        if (pageData) {
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
    console.error('Error listing all pages:', error);
    return [];
  }
}

// Get a single page by ID
export async function getPage(id: string, env: Env): Promise<Page | null> {
  try {
    const pageKey = `page/${id}`;
    return await getObject<Page>(pageKey, env);
  } catch (error) {
    console.error(`Error fetching page ${id}:`, error);
    return null;
  }
}

// Get a single page by slug
export async function getPageBySlug(slug: string, env: Env): Promise<Page | null> {
  try {
    // List all pages using cacheService
    const pagesList = await listObjects('page/', env);
    
    // Find the page with the matching slug
    for (const page of pagesList.objects) {
      const pageData = await getObject<Page>(page.key, env);
      if (pageData && pageData.slug === slug) {
        return pageData;
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
    parentPageId?: string;
    isHome?: boolean;
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
    
    // If this page is marked as home, update all other pages to not be home
    if (pageData.isHome) {
      for (const page of allPages) {
        if (page.isHome) {
          await updatePage(page.id, { isHome: false }, env);
        }
      }
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
      showInNavigation: pageData.showInNavigation ?? true,
      parentPageId: pageData.parentPageId,
      isHome: pageData.isHome ?? false
    };
    
    // Save the page using cacheService
    const pageKey = `page/${pageId}`;
    await putObject(pageKey, newPage, env);
    
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
    parentPageId?: string;
  },
  env: Env
): Promise<{ success: boolean; page?: Page; error?: string }> {
  try {
    // Get the existing page using cacheService
    const pageKey = `page/${id}`;
    const existingPage = await getObject<Page>(pageKey, env);
    
    if (!existingPage) {
      return { success: false, error: 'Page not found' };
    }
    
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
      parentPageId: updates.parentPageId !== undefined ? updates.parentPageId : existingPage.parentPageId,
      updatedAt: new Date().toISOString()
    };
    
    // Save the updated page using cacheService
    await putObject(pageKey, updatedPage, env);
    
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
    // Check if page exists using cacheService
    const pageKey = `page/${id}`;
    const existingPage = await getObject<Page>(pageKey, env);
    
    if (!existingPage) {
      return { success: false, error: 'Page not found' };
    }
    
    // Delete the page using cacheService
    await deleteObject(pageKey, env);
    
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
    // First try to find a page explicitly marked as home
    const pagesList = await listObjects('page/', env);
    
    for (const page of pagesList.objects) {
      const pageData = await getObject<Page>(page.key, env);
      if (pageData && pageData.isHome && pageData.published) {
        return pageData.content;
      }
    }
    
    // If no page is marked as home, try to get the page with slug 'home'
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
