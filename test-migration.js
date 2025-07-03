// Test script to check tables and run migration
// Run this in the browser console when logged in as an admin

const API_URL = 'https://api.scrivenly.com';

async function checkAndRunMigration() {
  console.log('🔍 Checking database tables...');
  
  try {
    // Get session ID from localStorage
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      console.error('❌ No session ID found. Please log in first.');
      return;
    }
    
    // Check what tables exist
    console.log('📋 Checking existing tables...');
    const tablesResponse = await fetch(`${API_URL}/admin/tables`, {
      headers: {
        Authorization: `Bearer ${sessionId}`,
      },
    });
    
    if (tablesResponse.ok) {
      const tablesData = await tablesResponse.json();
      console.log('📊 Current tables:', tablesData.tables);
      
      const hasTrackedChanges = tablesData.tables.some((table) => table.name === 'tracked_changes');
      const hasChangeComments = tablesData.tables.some((table) => table.name === 'change_comments');
      
      if (hasTrackedChanges && hasChangeComments) {
        console.log('✅ Tracked changes tables already exist!');
        return;
      } else {
        console.log('❌ Tracked changes tables missing:', {
          tracked_changes: hasTrackedChanges,
          change_comments: hasChangeComments
        });
      }
    } else {
      console.error('❌ Failed to get tables:', tablesResponse.status);
      return;
    }
    
    // Run migration
    console.log('🚀 Running tracked changes migration...');
    const migrationResponse = await fetch(`${API_URL}/admin/migrate/tracked-changes`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionId}`,
      },
    });
    
    if (migrationResponse.ok) {
      const migrationResult = await migrationResponse.json();
      console.log('✅ Migration completed:', migrationResult);
      
      // Check tables again
      console.log('📋 Checking tables after migration...');
      const tablesResponse2 = await fetch(`${API_URL}/admin/tables`, {
        headers: {
          Authorization: `Bearer ${sessionId}`,
        },
      });
      
      if (tablesResponse2.ok) {
        const tablesData2 = await tablesResponse2.json();
        console.log('📊 Tables after migration:', tablesData2.tables);
      }
    } else {
      const errorText = await migrationResponse.text();
      console.error('❌ Migration failed:', migrationResponse.status, errorText);
    }
    
  } catch (error) {
    console.error('❌ Error during migration check:', error);
  }
}

// Run the check
checkAndRunMigration(); 