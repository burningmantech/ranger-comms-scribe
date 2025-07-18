// Test script to check and create tracked changes tables
// This can be run in the browser console or as a Node.js script

const API_URL = 'https://scrivenly.com/api'; // Adjust this to your backend URL

async function testTrackedChangesTables() {
  console.log('Testing tracked changes tables...');
  
  // You'll need to replace these with actual values from your system
  const sessionId = 'your-session-id-here';
  const submissionId = 'a8595fa4-ea4b-473f-bae9-c8cccbf123fc'; // Use the submission ID from your error
  
  try {
    // Test 1: Try to get tracked changes (this should work if tables exist)
    console.log('Test 1: Checking if tracked changes endpoint works...');
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
    
    // Test 2: Try to create a tracked change (this will fail if tables don't exist)
    console.log('Test 2: Testing tracked change creation...');
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
    } else {
      const errorText = await createResponse.text();
      console.error('❌ Tracked change creation failed:', createResponse.status, errorText);
    }
    
  } catch (error) {
    console.error('❌ Error during testing:', error);
  }
}

// Run the test
testTrackedChangesTables(); 