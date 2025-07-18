import React, { useState } from 'react';
import { extractTextFromLexical, isLexicalJson } from '../../../utils/lexicalUtils';

const LexicalExtractionTest: React.FC = () => {
  const [lexicalJson, setLexicalJson] = useState(`{
  "root": {
    "children": [
      {
        "children": [
          {
            "detail": 0,
            "format": 0,
            "mode": "normal",
            "style": "",
            "text": "Hello",
            "type": "text",
            "version": 1
          },
          {
            "detail": 0,
            "format": 1,
            "mode": "normal",
            "style": "",
            "text": "world",
            "type": "text",
            "version": 1
          },
          {
            "detail": 0,
            "format": 0,
            "mode": "normal",
            "style": "",
            "text": "!",
            "type": "text",
            "version": 1
          }
        ],
        "direction": "ltr",
        "format": "",
        "indent": 0,
        "type": "paragraph",
        "version": 1,
        "textFormat": 0,
        "textStyle": ""
      },
      {
        "children": [
          {
            "detail": 0,
            "format": 0,
            "mode": "normal",
            "style": "",
            "text": "This is a",
            "type": "text",
            "version": 1
          },
          {
            "detail": 0,
            "format": 2,
            "mode": "normal",
            "style": "",
            "text": "test",
            "type": "text",
            "version": 1
          },
          {
            "detail": 0,
            "format": 0,
            "mode": "normal",
            "style": "",
            "text": "sentence.",
            "type": "text",
            "version": 1
          }
        ],
        "direction": "ltr",
        "format": "",
        "indent": 0,
        "type": "paragraph",
        "version": 1,
        "textFormat": 0,
        "textStyle": ""
      }
    ],
    "direction": "ltr",
    "format": "",
    "indent": 0,
    "type": "root",
    "version": 1
  }
}`);

  const [extractedText, setExtractedText] = useState('');
  const [isValidJson, setIsValidJson] = useState(false);

  const handleExtract = () => {
    try {
      const isValid = isLexicalJson(lexicalJson);
      setIsValidJson(isValid);
      
      if (isValid) {
        const text = extractTextFromLexical(lexicalJson);
        setExtractedText(text);
      } else {
        setExtractedText('Invalid Lexical JSON format');
      }
    } catch (error) {
      setExtractedText(`Error: ${error}`);
      setIsValidJson(false);
    }
  };

  return (
    <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto' }}>
      <h1>Lexical JSON Extraction Test</h1>
      
      <div style={{ marginBottom: '20px' }}>
        <h3>Input Lexical JSON:</h3>
        <textarea
          value={lexicalJson}
          onChange={(e) => setLexicalJson(e.target.value)}
          style={{ width: '100%', height: '300px', fontFamily: 'monospace' }}
        />
      </div>

      <button onClick={handleExtract} style={{ marginBottom: '20px' }}>
        Extract Text
      </button>

      <div style={{ marginBottom: '20px' }}>
        <h3>Is Valid Lexical JSON:</h3>
        <span style={{ color: isValidJson ? 'green' : 'red' }}>
          {isValidJson ? 'Yes' : 'No'}
        </span>
      </div>

      <div style={{ marginBottom: '20px' }}>
        <h3>Extracted Text:</h3>
        <div style={{ 
          padding: '10px', 
          border: '1px solid #ccc', 
          backgroundColor: '#f9f9f9',
          whiteSpace: 'pre-wrap',
          fontFamily: 'monospace'
        }}>
          {extractedText || 'No text extracted yet'}
        </div>
      </div>

      <div style={{ marginBottom: '20px' }}>
        <h3>Expected Result (Fixed):</h3>
        <div style={{ 
          padding: '10px', 
          border: '1px solid #ccc', 
          backgroundColor: '#e8f5e8',
          whiteSpace: 'pre-wrap',
          fontFamily: 'monospace'
        }}>
          Hello world !
This is a test sentence.
        </div>
      </div>

      <div style={{ marginBottom: '20px' }}>
        <h3>What This Tests:</h3>
        <div style={{ 
          padding: '10px', 
          border: '1px solid #ccc', 
          backgroundColor: '#fff3cd',
          fontSize: '14px'
        }}>
          <p><strong>Problem:</strong> Multiple text nodes within the same paragraph were being concatenated without spaces, causing words to run together like "Helloworld!" instead of "Hello world !"</p>
          <p><strong>Solution:</strong> The extractTextFromLexical function now joins text nodes with spaces to maintain proper word separation.</p>
          <p><strong>Test Case:</strong> This JSON has multiple text nodes with different formatting (bold, italic) within the same paragraph, which should be properly spaced when extracted.</p>
        </div>
      </div>
    </div>
  );
};

export default LexicalExtractionTest; 