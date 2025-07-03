// Test script for tracked changes functionality
// Run this in the browser console or as a Node.js script

const API_URL = 'http://localhost:8787'; // Adjust this to your backend URL

async function testTrackedChanges() {
  console.log('Testing tracked changes functionality...');
  
  // You'll need to replace these with actual values from your system
  const sessionId = 'your-session-id-here';
  const submissionId = 'your-submission-id-here';
  
  try {
    // Test 1: Get tracked changes for a submission
    console.log('Test 1: Getting tracked changes...');
    const getResponse = await fetch(`${API_URL}/tracked-changes/submission/${submissionId}`, {
      headers: {
        Authorization: `Bearer ${sessionId}`,
      },
    });
    
    if (getResponse.ok) {
      const changes = await getResponse.json();
      console.log('✅ Tracked changes retrieved successfully:', changes);
    } else {
      console.error('❌ Failed to get tracked changes:', getResponse.status, getResponse.statusText);
    }
    
    // Test 2: Create a new tracked change
    console.log('Test 2: Creating a new tracked change...');
    const newChange = {
      field: 'content',
      oldValue: 'old text',
      newValue: 'new text'
    };
    
    const createResponse = await fetch(`${API_URL}/tracked-changes/submission/${submissionId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionId}`,
      },
      body: JSON.stringify(newChange),
    });
    
    if (createResponse.ok) {
      const createdChange = await createResponse.json();
      console.log('✅ Tracked change created successfully:', createdChange);
      
      // Test 3: Approve the change
      console.log('Test 3: Approving the change...');
      const approveResponse = await fetch(`${API_URL}/tracked-changes/change/${createdChange.id}/status`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({ status: 'approved' }),
      });
      
      if (approveResponse.ok) {
        console.log('✅ Change approved successfully');
      } else {
        console.error('❌ Failed to approve change:', approveResponse.status, approveResponse.statusText);
      }
    } else {
      console.error('❌ Failed to create tracked change:', createResponse.status, createResponse.statusText);
    }
    
  } catch (error) {
    console.error('❌ Error during testing:', error);
  }
}

// Run the test
testTrackedChanges(); 