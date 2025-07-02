-- Migration: Add tracked changes functionality
-- Version: 003
-- Description: Add tables for tracking changes, approvals, and comments

-- Table for tracking individual changes
CREATE TABLE IF NOT EXISTS tracked_changes (
  id TEXT PRIMARY KEY,
  submissionId TEXT NOT NULL,
  field TEXT NOT NULL,
  oldValue TEXT NOT NULL,
  newValue TEXT NOT NULL,
  changedBy TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  approvedBy TEXT,
  approvedAt TEXT,
  rejectedBy TEXT,
  rejectedAt TEXT,
  FOREIGN KEY (submissionId) REFERENCES content_submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (changedBy) REFERENCES users(id),
  FOREIGN KEY (approvedBy) REFERENCES users(id),
  FOREIGN KEY (rejectedBy) REFERENCES users(id)
);

-- Table for comments on changes
CREATE TABLE IF NOT EXISTS change_comments (
  id TEXT PRIMARY KEY,
  changeId TEXT NOT NULL,
  submissionId TEXT NOT NULL,
  content TEXT NOT NULL,
  authorId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (changeId) REFERENCES tracked_changes(id) ON DELETE CASCADE,
  FOREIGN KEY (submissionId) REFERENCES content_submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (authorId) REFERENCES users(id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tracked_changes_submission ON tracked_changes(submissionId);
CREATE INDEX IF NOT EXISTS idx_tracked_changes_status ON tracked_changes(status);
CREATE INDEX IF NOT EXISTS idx_tracked_changes_timestamp ON tracked_changes(timestamp);
CREATE INDEX IF NOT EXISTS idx_change_comments_change ON change_comments(changeId);
CREATE INDEX IF NOT EXISTS idx_change_comments_submission ON change_comments(submissionId);

-- Add change tracking fields to content_submissions if not exists
ALTER TABLE content_submissions ADD COLUMN IF NOT EXISTS hasTrackedChanges BOOLEAN DEFAULT FALSE;
ALTER TABLE content_submissions ADD COLUMN IF NOT EXISTS lastChangeAt TEXT;