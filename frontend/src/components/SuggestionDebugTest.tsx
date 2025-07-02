import React from 'react';
import LexicalEditorComponent from './editor/LexicalEditor';

export const SuggestionDebugTest: React.FC = () => {
  const testUser = {
    id: 'test-user',
    email: 'test@example.com',
    name: 'Test User',
    roles: ['REVIEWER', 'CommsCadre'] as const
  };

  const handleSuggestionCreate = (suggestion: any) => {
    console.log('🎯 Suggestion created:', suggestion);
    alert('Suggestion created successfully!');
  };

  const handleSuggestionApprove = (suggestionId: string, reason?: string) => {
    console.log('✅ Suggestion approved:', suggestionId, reason);
    alert(`Suggestion ${suggestionId} approved!`);
  };

  const handleSuggestionReject = (suggestionId: string, reason?: string) => {
    console.log('❌ Suggestion rejected:', suggestionId, reason);
    alert(`Suggestion ${suggestionId} rejected!`);
  };

  return (
    <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto' }}>
      <h2>🧪 Suggestion Dialog Debug Test</h2>
      <p>
        <strong>Instructions:</strong> Select some text in the editor below. 
        A suggestion dialog should appear allowing you to suggest changes.
      </p>
      
      <div style={{ 
        border: '2px solid #007bff', 
        borderRadius: '8px', 
        padding: '16px',
        margin: '20px 0',
        backgroundColor: '#f8f9fa'
      }}>
        <h3>Test Editor</h3>
        <LexicalEditorComponent
          initialContent="This is some test content. Try selecting some of this text to create a suggestion!"
          placeholder="Type something here..."
          currentUserId={testUser.id}
          onSuggestionCreate={handleSuggestionCreate}
          onSuggestionApprove={handleSuggestionApprove}
          onSuggestionReject={handleSuggestionReject}
          canCreateSuggestions={true}
          canApproveSuggestions={true}
          className="h-40"
        />
      </div>

      <div style={{ 
        backgroundColor: '#fff3cd', 
        border: '1px solid #ffeaa7',
        borderRadius: '4px',
        padding: '12px',
        marginTop: '20px'
      }}>
        <h4>🔍 Debugging Tips:</h4>
        <ul>
          <li>Open browser console to see debug logs</li>
          <li>Look for "SuggestionPlugin mounted with permissions" message</li>
          <li>Try clicking the blue "Test Suggestion Dialog" button in top-right</li>
          <li>If dialog doesn't appear, check console for permission errors</li>
          <li>Make sure to <strong>select text</strong> (not just click)</li>
        </ul>
      </div>

      <div style={{ 
        backgroundColor: '#d1ecf1', 
        border: '1px solid #bee5eb',
        borderRadius: '4px',
        padding: '12px',
        marginTop: '10px'
      }}>
        <h4>📋 Expected Behavior:</h4>
        <ol>
          <li>Select text in the editor above</li>
          <li>A modal dialog should appear with "Suggest Edit" title</li>
          <li>Original text should show in read-only field</li>
          <li>You can type new text in the textarea</li>
          <li>Click "Create Suggestion" to submit</li>
        </ol>
      </div>
    </div>
  );
}; 