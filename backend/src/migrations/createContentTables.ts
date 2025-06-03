import { Env } from '../utils/sessionManager';

export async function createContentTables(env: Env) {
  // Create content_submissions table
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS content_submissions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      submittedBy TEXT NOT NULL,
      submittedAt TEXT NOT NULL,
      status TEXT NOT NULL,
      formFields TEXT NOT NULL,
      comments TEXT NOT NULL,
      approvals TEXT NOT NULL,
      changes TEXT NOT NULL,
      commsCadreApprovals INTEGER NOT NULL DEFAULT 0,
      councilManagerApprovals TEXT NOT NULL,
      announcementSent BOOLEAN NOT NULL DEFAULT 0,
      FOREIGN KEY (submittedBy) REFERENCES users(id)
    )
  `);

  // Create council_members table
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS council_members (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      role TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id)
    )
  `);

  // Create reminders table
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      submissionId TEXT NOT NULL,
      approverId TEXT NOT NULL,
      lastSentAt TEXT NOT NULL,
      nextSendAt TEXT NOT NULL,
      status TEXT NOT NULL,
      FOREIGN KEY (submissionId) REFERENCES content_submissions(id),
      FOREIGN KEY (approverId) REFERENCES users(id)
    )
  `);

  // Create comms_cadre table
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS comms_cadre (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id)
    )
  `);
}

// Add this to the initialization process
export async function initializeContentTables(env: Env) {
  try {
    console.log('Creating content-related tables...');
    await createContentTables(env);
    console.log('Content-related tables created successfully');
  } catch (error) {
    console.error('Error creating content-related tables:', error);
    throw error;
  }
} 