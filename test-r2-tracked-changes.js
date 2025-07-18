// Test script for R2-based tracked changes functionality
// Run this in the browser console when logged in

const API_URL = 'https://scrivenly.com/api';

async function testR2TrackedChanges() {
  console.log('🧪 Testing R2-based tracked changes...');
  
  try {
    // Get session ID from localStorage
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      console.error('❌ No session ID found. Please log in first.');
      return;
    }
    
    const submissionId = 'a8595fa4-ea4b-473f-bae9-c8cccbf123fc'; // Use your submission ID
    
    // Test 1: Get tracked changes (should work now)
    console.log('📋 Test 1: Getting tracked changes...');
    const getResponse = await fetch(`${API_URL}/tracked-changes/submission/${submissionId}`, {
      headers: {
        Authorization: `Bearer ${sessionId}`,
      },
    });
    
    console.log('GET response status:', getResponse.status);
    if (getResponse.ok) {
      const changes = await getResponse.json();
      console.log('✅ Tracked changes endpoint works:', changes);
    } else {
      const errorText = await getResponse.text();
      console.error('❌ Tracked changes endpoint failed:', getResponse.status, errorText);
    }
    
    // Test 2: Create a tracked change
    console.log('📝 Test 2: Creating tracked change...');
    const newChange = {
      field: 'content',
      oldValue: 'test old value',
      newValue: 'test new value'
    };
    
    const createResponse = await fetch(`${API_URL}/tracked-changes/submission/${submissionId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionId}`,
      },
      body: JSON.stringify(newChange),
    });
    
    console.log('POST response status:', createResponse.status);
    if (createResponse.ok) {
      const createdChange = await createResponse.json();
      console.log('✅ Tracked change creation works:', createdChange);
      
      // Test 3: Get tracked changes again to see the new change
      console.log('📋 Test 3: Getting tracked changes after creation...');
      const getResponse2 = await fetch(`${API_URL}/tracked-changes/submission/${submissionId}`, {
        headers: {
          Authorization: `Bearer ${sessionId}`,
        },
      });
      
      if (getResponse2.ok) {
        const changes2 = await getResponse2.json();
        console.log('✅ Updated tracked changes:', changes2);
        console.log('✅ Change count:', changes2.length);
      }
    } else {
      const errorText = await createResponse.text();
      console.error('❌ Tracked change creation failed:', createResponse.status, errorText);
    }
    
  } catch (error) {
    console.error('❌ Error during testing:', error);
  }
}

// Run the test
testR2TrackedChanges(); 