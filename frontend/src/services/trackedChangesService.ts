import { API_URL } from '../config';
import { Change, Comment } from '../types/content';

export interface TrackedChangeResponse {
  id: string;
  submissionId: string;
  field: string;
  oldValue: string;
  newValue: string;
  changedBy: string;
  changedByName: string;
  timestamp: string;
  status: 'pending' | 'approved' | 'rejected';
  approvedBy?: string;
  approvedByName?: string;
  rejectedBy?: string;
  rejectedByName?: string;
  approvedAt?: string;
  rejectedAt?: string;
  comments: ChangeComment[];
}

export interface ChangeComment {
  id: string;
  changeId: string;
  submissionId: string;
  content: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}

export interface ChangeHistoryStats {
  totalChanges: number;
  pendingChanges: number;
  approvedChanges: number;
  rejectedChanges: number;
  uniqueContributors: number;
}

class TrackedChangesService {
  private getAuthHeaders(): HeadersInit {
    const sessionId = localStorage.getItem('sessionId');
    return {
      'Content-Type': 'application/json',
      'Authorization': sessionId ? `Bearer ${sessionId}` : ''
    };
  }

  async getTrackedChanges(submissionId: string): Promise<TrackedChangeResponse[]> {
    try {
      const response = await fetch(`${API_URL}/tracked-changes/submission/${submissionId}`, {
        headers: this.getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch tracked changes: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching tracked changes:', error);
      throw error;
    }
  }

  async createTrackedChange(submissionId: string, change: {
    field: string;
    oldValue: string;
    newValue: string;
  }): Promise<TrackedChangeResponse> {
    try {
      const response = await fetch(`${API_URL}/tracked-changes/submission/${submissionId}`, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify(change)
      });

      if (!response.ok) {
        throw new Error(`Failed to create tracked change: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error creating tracked change:', error);
      throw error;
    }
  }

  async updateChangeStatus(changeId: string, status: 'approved' | 'rejected', comment?: string): Promise<void> {
    try {
      const response = await fetch(`${API_URL}/tracked-changes/change/${changeId}/status`, {
        method: 'PUT',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({ status, comment })
      });

      if (!response.ok) {
        throw new Error(`Failed to update change status: ${response.statusText}`);
      }
    } catch (error) {
      console.error('Error updating change status:', error);
      throw error;
    }
  }

  async addChangeComment(changeId: string, content: string): Promise<ChangeComment> {
    try {
      const response = await fetch(`${API_URL}/tracked-changes/change/${changeId}/comment`, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({ content })
      });

      if (!response.ok) {
        throw new Error(`Failed to add comment: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error adding comment:', error);
      throw error;
    }
  }

  async getChangeHistory(params?: {
    startDate?: string;
    endDate?: string;
    userId?: string;
  }): Promise<{ changes: TrackedChangeResponse[]; stats: ChangeHistoryStats }> {
    try {
      const queryParams = new URLSearchParams();
      if (params?.startDate) queryParams.append('startDate', params.startDate);
      if (params?.endDate) queryParams.append('endDate', params.endDate);
      if (params?.userId) queryParams.append('userId', params.userId);

      const url = `${API_URL}/tracked-changes/history${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
      const response = await fetch(url, {
        headers: this.getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch change history: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching change history:', error);
      throw error;
    }
  }

  // Helper method to convert API response to frontend Change type
  convertToChange(apiChange: TrackedChangeResponse): Change {
    return {
      id: apiChange.id,
      field: apiChange.field,
      oldValue: apiChange.oldValue,
      newValue: apiChange.newValue,
      changedBy: apiChange.changedByName || apiChange.changedBy,
      timestamp: new Date(apiChange.timestamp)
    };
  }

  // Helper method to convert API response to frontend Comment type
  convertToComment(apiComment: ChangeComment): Comment {
    return {
      id: apiComment.id,
      content: apiComment.content,
      authorId: apiComment.authorId,
      createdAt: new Date(apiComment.createdAt),
      type: 'COMMENT',
      resolved: false
    };
  }
}

export const trackedChangesService = new TrackedChangesService();