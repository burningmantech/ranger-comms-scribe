// First, import the mock helper
import { createCacheServiceMock, __getStorage, __clearStorage } from './cache-mock-helpers';

// Set up the mock before any other imports that might use cacheService
jest.mock('../../src/services/cacheService', () => createCacheServiceMock());

import {
  getPage,
  getPages,
  getAllPages,
  getPageBySlug,
  createPage,
  updatePage,
  deletePage
} from '../../src/services/pageService';
import { mockEnv, setupMockStorage } from './test-helpers';
import { Page } from '../../src/types';

// Import the mocked cacheService functions for use in tests
import {
  getObject,
  putObject,
  deleteObject,
  listObjects
} from '../../src/services/cacheService';

describe('Page Service', () => {
  let env: any;

  // Sample page data for testing
  const samplePage = {
    title: 'Test Page',
    slug: 'test-page',
    content: 'This is a test page',
    published: true,
    isPublic: true
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    env = mockEnv();
    __clearStorage(); // Clear the mock cache storage
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createPage', () => {
    it('should create a new page', async () => {
      const result = await createPage(
        samplePage,
        'admin@example.com',
        'Admin User',
        env
      );
      
      expect(result.success).toBe(true);
      expect(result.page).toBeDefined();
      expect(result.page?.title).toBe('Test Page');
      expect(result.page?.slug).toBe('test-page');
      expect(result.page?.createdBy).toBe('Admin User');
      expect(result.page?.isPublic).toBe(true);
      
      // Verify the page was stored in R2
      const storedPage = await getPage(result.page!.id, env);
      expect(storedPage).toBeDefined();
      expect(storedPage?.title).toBe('Test Page');
    });

    it('should reject invalid slugs', async () => {
      const invalidPage = {
        ...samplePage,
        slug: 'invalid slug with spaces'
      };
      
      const result = await createPage(invalidPage, 'admin@example.com', 'Admin User', env);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Slug must contain only');
    });
    
    it('should reject duplicate slugs', async () => {
      // Create first page
      await createPage(samplePage, 'admin@example.com', 'Admin User', env);
      
      // Try to create a second page with the same slug
      const duplicatePage = {
        ...samplePage
      };
      
      const result = await createPage(duplicatePage, 'admin@example.com', 'Admin User', env);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });
    
    it('should set proper default values', async () => {
      const minimalPage = {
        title: 'Minimal Page',
        slug: 'minimal',
        content: 'Minimal content'
      };
      
      const result = await createPage(minimalPage, 'admin@example.com', 'Admin User', env);
      
      expect(result.success).toBe(true);
      expect(result.page?.published).toBe(false);
      expect(result.page?.isPublic).toBe(true);
      expect(result.page?.showInNavigation).toBe(true);
      expect(result.page?.order).toBeGreaterThan(0);
      expect(result.page?.createdAt).toBeDefined();
      expect(result.page?.updatedAt).toBeDefined();
    });
    
    it('should handle R2 errors gracefully', async () => {
      // Mock putObject to throw an error
      (putObject as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const result = await createPage(samplePage, 'admin@example.com', 'Admin User', env);
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('Mock cache error');
    });
  });

  describe('getPage', () => {
    it('should return a page by ID', async () => {
      // Create a page first
      const createResult = await createPage(samplePage, 'admin@example.com', 'Admin User', env);
      const pageId = createResult.page!.id;
      
      const page = await getPage(pageId, env);
      
      expect(page).toBeDefined();
      expect(page?.id).toBe(pageId);
      expect(page?.title).toBe('Test Page');
    });
    
    it('should return null for non-existent pages', async () => {
      const page = await getPage('nonexistent-id', env);
      
      expect(page).toBeNull();
    });
    
    it('should handle R2 errors gracefully', async () => {
      // Create a page first
      const createResult = await createPage(samplePage, 'admin@example.com', 'Admin User', env);
      const pageId = createResult.page!.id;
      
      // Mock getObject to throw an error
      (getObject as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const page = await getPage(pageId, env);
      
      expect(page).toBeNull();
    });
  });

  describe('getPageBySlug', () => {
    it('should return a page by slug', async () => {
      // Create a page first
      await createPage(samplePage, 'admin@example.com', 'Admin User', env);
      
      const page = await getPageBySlug('test-page', env);
      
      expect(page).toBeDefined();
      expect(page?.slug).toBe('test-page');
      expect(page?.title).toBe('Test Page');
    });
    
    it('should return null for non-existent slugs', async () => {
      const page = await getPageBySlug('nonexistent-slug', env);
      
      expect(page).toBeNull();
    });
    
    it('should handle R2 errors gracefully', async () => {
      // Create a page first
      await createPage(samplePage, 'admin@example.com', 'Admin User', env);
      
      // Mock listObjects to throw an error
      (listObjects as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const page = await getPageBySlug('test-page', env);
      
      expect(page).toBeNull();
    });
  });

  describe('getPages', () => {
    it('should return only published and public pages by default', async () => {
      // Create published and public page
      await createPage(samplePage, 'admin@example.com', 'Admin User', env);
      
      // Create unpublished page
      await createPage(
        { ...samplePage, title: 'Draft Page', slug: 'draft-page', published: false },
        'admin@example.com',
        'Admin User',
        env
      );
      
      // Create private page
      await createPage(
        { ...samplePage, title: 'Private Page', slug: 'private-page', isPublic: false },
        'admin@example.com',
        'Admin User',
        env
      );
      
      // Get published and public pages
      const pages = await getPages(env);
      
      expect(pages.length).toBe(1);
      expect(pages[0].title).toBe('Test Page');
    });
    
    it('should include private pages when user ID is provided', async () => {
      // Create published and public page
      await createPage(samplePage, 'admin@example.com', 'Admin User', env);
      
      // Create private page
      await createPage(
        { ...samplePage, title: 'Private Page', slug: 'private-page', isPublic: false },
        'admin@example.com',
        'Admin User',
        env
      );
      
      // Get pages with user ID
      const pages = await getPages(env, 'member@example.com');
      
      expect(pages.length).toBe(2);
      expect(pages.some(page => page.title === 'Test Page')).toBe(true);
      expect(pages.some(page => page.title === 'Private Page')).toBe(true);
    });
    
    it('should sort pages by order', async () => {
      // Create pages with different orders
      await createPage(
        { ...samplePage, title: 'Page A', slug: 'page-a', order: 30 },
        'admin@example.com',
        'Admin User',
        env
      );
      
      await createPage(
        { ...samplePage, title: 'Page B', slug: 'page-b', order: 10 },
        'admin@example.com',
        'Admin User',
        env
      );
      
      await createPage(
        { ...samplePage, title: 'Page C', slug: 'page-c', order: 20 },
        'admin@example.com',
        'Admin User',
        env
      );
      
      // Get pages
      const pages = await getPages(env);
      
      expect(pages.length).toBe(3);
      expect(pages[0].title).toBe('Page B'); // Order 10
      expect(pages[1].title).toBe('Page C'); // Order 20
      expect(pages[2].title).toBe('Page A'); // Order 30
    });
    
    it('should handle R2 errors gracefully', async () => {
      // Create a page first
      await createPage(samplePage, 'admin@example.com', 'Admin User', env);
      
      // Mock listObjects to throw an error
      (listObjects as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const pages = await getPages(env);
      
      expect(pages).toEqual([]);
    });
  });

  describe('getAllPages', () => {
    it('should return all pages including unpublished ones', async () => {
      // Create published page
      await createPage(samplePage, 'admin@example.com', 'Admin User', env);
      
      // Create unpublished page
      await createPage(
        { ...samplePage, title: 'Draft Page', slug: 'draft-page', published: false },
        'admin@example.com',
        'Admin User',
        env
      );
      
      // Get all pages
      const pages = await getAllPages(env);
      
      expect(pages.length).toBe(2);
      expect(pages.some(page => page.title === 'Test Page')).toBe(true);
      expect(pages.some(page => page.title === 'Draft Page')).toBe(true);
    });
    
    it('should sort pages by order', async () => {
      // Create pages with different orders
      await createPage(
        { ...samplePage, title: 'Page A', slug: 'page-a', order: 30 },
        'admin@example.com',
        'Admin User',
        env
      );
      
      await createPage(
        { ...samplePage, title: 'Page B', slug: 'page-b', order: 10 },
        'admin@example.com',
        'Admin User',
        env
      );
      
      // Get all pages
      const pages = await getAllPages(env);
      
      expect(pages.length).toBe(2);
      expect(pages[0].title).toBe('Page B'); // Order 10
      expect(pages[1].title).toBe('Page A'); // Order 30
    });
    
    it('should handle R2 errors gracefully', async () => {
      // Create a page first
      await createPage(samplePage, 'admin@example.com', 'Admin User', env);
      
      // Mock listObjects to throw an error
      (listObjects as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const pages = await getAllPages(env);
      
      expect(pages).toEqual([]);
    });
  });

  describe('updatePage', () => {
    it('should update an existing page', async () => {
      // Create a page first
      const createResult = await createPage(samplePage, 'admin@example.com', 'Admin User', env);
      const pageId = createResult.page!.id;
      
      const updates = {
        title: 'Updated Page Title',
        content: 'Updated content',
        published: false
      };
      
      const result = await updatePage(pageId, updates, env);
      
      expect(result.success).toBe(true);
      expect(result.page).toBeDefined();
      expect(result.page?.id).toBe(pageId);
      expect(result.page?.title).toBe('Updated Page Title');
      expect(result.page?.content).toBe('Updated content');
      expect(result.page?.published).toBe(false);
      
      // Verify the page was updated in R2
      const updatedPage = await getPage(pageId, env);
      expect(updatedPage?.title).toBe('Updated Page Title');
    });
    
    it('should reject invalid slugs', async () => {
      // Create a page first
      const createResult = await createPage(samplePage, 'admin@example.com', 'Admin User', env);
      const pageId = createResult.page!.id;
      
      const updates = {
        slug: 'invalid slug with spaces'
      };
      
      const result = await updatePage(pageId, updates, env);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Slug must contain only');
    });
    
    it('should reject duplicate slugs', async () => {
      // Create first page
      await createPage(samplePage, 'admin@example.com', 'Admin User', env);
      
      // Create second page
      const secondPage = {
        title: 'Second Page',
        slug: 'second-page',
        content: 'Content of the second page'
      };
      const createResult = await createPage(secondPage, 'admin@example.com', 'Admin User', env);
      const pageId = createResult.page!.id;
      
      // Try to update second page to use first page's slug
      const updates = {
        slug: 'test-page'
      };
      
      const result = await updatePage(pageId, updates, env);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });
    
    it('should return error for non-existent pages', async () => {
      const updates = {
        title: 'Updated Title',
        content: 'Updated content'
      };
      
      const result = await updatePage('nonexistent-id', updates, env);
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('Page not found');
    });
    
    it('should handle R2 errors gracefully', async () => {
      // Create a page first
      const createResult = await createPage(samplePage, 'admin@example.com', 'Admin User', env);
      const pageId = createResult.page!.id;
      
      // Mock putObject to throw an error
      (putObject as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const updates = {
        title: 'Error Update',
        content: 'This update will fail'
      };
      
      const result = await updatePage(pageId, updates, env);
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('Mock cache error');
    });
  });

  describe('deletePage', () => {
    it('should delete a page', async () => {
      // Create a page first
      const createResult = await createPage(samplePage, 'admin@example.com', 'Admin User', env);
      const pageId = createResult.page!.id;
      
      // Verify the page exists
      const pageBefore = await getPage(pageId, env);
      expect(pageBefore).not.toBeNull();
      
      const result = await deletePage(pageId, env);
      
      expect(result.success).toBe(true);
      
      // Verify the page was deleted
      const pageAfter = await getPage(pageId, env);
      expect(pageAfter).toBeNull();
    });
    
    it('should return error for non-existent pages', async () => {
      const result = await deletePage('nonexistent-id', env);
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('Page not found');
    });
    
    it('should handle R2 errors gracefully', async () => {
      // Create a page first
      const createResult = await createPage(samplePage, 'admin@example.com', 'Admin User', env);
      const pageId = createResult.page!.id;
      
      // Mock deleteObject to throw an error
      (deleteObject as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const result = await deletePage(pageId, env);
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('Mock cache error');
    });
  });
});