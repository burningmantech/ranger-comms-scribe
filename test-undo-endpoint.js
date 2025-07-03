// Simple test script to verify the undo endpoint
const { undoChange } = require('./dist/services/trackedChangesService');

// Mock environment for testing
const mockEnv = {
  R2: {
    list: async () => ({
      objects: [
        { key: 'tracked-changes/submission/test-submission/test-change' }
      ]
    }),
    get: async () => ({
      json: async () => ({
        id: 'test-change',
        submissionId: 'test-submission',
        field: 'content',
        oldValue: 'old content',
        newValue: 'new content',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: new Date().toISOString(),
        status: 'approved',
        approvedBy: 'user2',
        approvedByName: 'User Two',
        approvedAt: new Date().toISOString()
      })
    }),
    put: async () => undefined,
    delete: async () => undefined
  },
  CACHE: {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [] })
  }
};

async function testUndo() {
  try {
    console.log('Testing undo functionality...');
    const result = await undoChange('test-change', mockEnv);
    
    if (result) {
      console.log('✅ Undo successful!');
      console.log('Status:', result.status);
      console.log('Approved by:', result.approvedBy);
      console.log('Approved at:', result.approvedAt);
    } else {
      console.log('❌ Undo failed - returned null');
    }
  } catch (error) {
    console.error('❌ Error testing undo:', error);
  }
}

testUndo(); 