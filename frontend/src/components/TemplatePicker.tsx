import React, { useState, useEffect } from 'react';
import { API_URL } from '../config';
import './TemplatePicker.css';

interface Template {
  id: string;
  name: string;
  description: string;
  fields: Record<string, any>;
}

interface TemplatePickerProps {
  selectedId: string | null;
  onSelect: (template: Template | null) => void;
}

const TemplatePicker: React.FC<TemplatePickerProps> = ({ selectedId, onSelect }) => {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchTemplates = async () => {
      try {
        const sessionId = localStorage.getItem('sessionId');
        const res = await fetch(`${API_URL}/templates`, {
          headers: { Authorization: `Bearer ${sessionId}` },
        });
        if (res.ok) {
          setTemplates(await res.json());
        }
      } catch {
        // Templates are optional — fail silently
      } finally {
        setLoading(false);
      }
    };
    fetchTemplates();
  }, []);

  if (loading || templates.length === 0) return null;

  return (
    <div className="template-picker">
      <div className="template-picker__label">Start from a template (optional)</div>
      <div className="template-picker__row">
        <button
          type="button"
          className={`template-picker__card ${selectedId === null ? 'template-picker__card--selected' : ''}`}
          onClick={() => onSelect(null)}
        >
          <i className="fas fa-file template-picker__icon" />
          <span className="template-picker__name">Start Blank</span>
        </button>
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`template-picker__card ${selectedId === t.id ? 'template-picker__card--selected' : ''}`}
            onClick={() => onSelect(t)}
          >
            <i className="fas fa-file-alt template-picker__icon" />
            <span className="template-picker__name">{t.name}</span>
            {t.description && <span className="template-picker__desc">{t.description}</span>}
          </button>
        ))}
      </div>
    </div>
  );
};

export default TemplatePicker;
