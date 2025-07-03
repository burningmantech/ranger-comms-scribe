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
            "text": "foo",
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
            "text": "Bar ",
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
            "text": "Baz",
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
        <h3>Expected Result:</h3>
        <div style={{ 
          padding: '10px', 
          border: '1px solid #ccc', 
          backgroundColor: '#e8f5e8',
          whiteSpace: 'pre-wrap',
          fontFamily: 'monospace'
        }}>
          foo
Bar 
Baz
        </div>
      </div>
    </div>
  );
};

export default LexicalExtractionTest; 