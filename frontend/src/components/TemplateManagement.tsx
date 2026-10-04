import React, { useState, useEffect, useCallback } from 'react';
import { API_URL } from '../config';
import './TemplateManagement.css';

interface SubmissionTemplate {
  id: string;
  name: string;
  description: string;
  fields: {
    audience?: string[];
    signatureText?: string;
    suggestedSubjectLine?: string;
    description?: string;
    [key: string]: any;
  };
  sortOrder: number;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const AUDIENCE_OPTIONS = [
  { value: 'newsletter', label: 'Ranger Newsletter' },
  { value: 'singular', label: 'Singular Announcement' },
  { value: 'allcom', label: 'Allcom' },
  { value: 'website_fix', label: 'Website - Fix' },
  { value: 'website_update', label: 'Website - Update' },
  { value: 'jrs', label: 'JRS/Event Ops/Other BMP' },
  { value: 'event', label: 'Event Planning' },
  { value: 'other', label: 'Other' },
];

const emptyForm: Omit<SubmissionTemplate, 'id' | 'createdBy' | 'createdAt' | 'updatedAt'> = {
  name: '',
  description: '',
  fields: { audience: [], signatureText: '', suggestedSubjectLine: '', description: '' },
  sortOrder: 0,
  active: true,
};

const TemplateManagement: React.FC = () => {
  const [templates, setTemplates] = useState<SubmissionTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const sessionId = localStorage.getItem('sessionId');

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/templates/admin`, {
        headers: { Authorization: `Bearer ${sessionId}` },
      });
      if (!res.ok) throw new Error('Failed to fetch templates');
      const data = await res.json();
      setTemplates(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const url = editingId
        ? `${API_URL}/templates/${editingId}`
        : `${API_URL}/templates`;
      const method = editingId ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify(form),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save template');
      }

      await fetchTemplates();
      setEditingId(null);
      setShowAddForm(false);
      setForm(emptyForm);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this template?')) return;
    try {
      const res = await fetch(`${API_URL}/templates/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${sessionId}` },
      });
      if (!res.ok) throw new Error('Failed to delete template');
      await fetchTemplates();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const startEdit = (template: SubmissionTemplate) => {
    setEditingId(template.id);
    setShowAddForm(false);
    setForm({
      name: template.name,
      description: template.description,
      fields: { ...template.fields },
      sortOrder: template.sortOrder,
      active: template.active,
    });
  };

  const startAdd = () => {
    setEditingId(null);
    setShowAddForm(true);
    setForm({
      ...emptyForm,
      sortOrder: templates.length,
      fields: { audience: [], signatureText: '', suggestedSubjectLine: '', description: '' },
    });
  };

  const cancelForm = () => {
    setEditingId(null);
    setShowAddForm(false);
    setForm(emptyForm);
  };

  const toggleAudience = (value: string) => {
    const current = form.fields.audience || [];
    const updated = current.includes(value)
      ? current.filter(v => v !== value)
      : [...current, value];
    setForm({ ...form, fields: { ...form.fields, audience: updated } });
  };

  if (loading) return <div className="template-mgmt__loading">Loading templates...</div>;

  return (
    <div className="template-mgmt">
      <div className="template-mgmt__header">
        <h2>Submission Templates</h2>
        <button className="btn btn-primary btn-sm" onClick={startAdd} disabled={showAddForm}>
          + Add Template
        </button>
      </div>

      {error && <div className="template-mgmt__error">{error}</div>}

      {(showAddForm || editingId) && (
        <div className="template-mgmt__form">
          <h3>{editingId ? 'Edit Template' : 'New Template'}</h3>

          <div className="template-mgmt__field">
            <label>Name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g., Newsletter Announcement"
            />
          </div>

          <div className="template-mgmt__field">
            <label>Description</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Brief description shown to submitters"
              rows={2}
            />
          </div>

          <div className="template-mgmt__field">
            <label>Default Audience</label>
            <div className="template-mgmt__audience-grid">
              {AUDIENCE_OPTIONS.map(opt => (
                <label key={opt.value} className="template-mgmt__checkbox-label">
                  <input
                    type="checkbox"
                    checked={(form.fields.audience || []).includes(opt.value)}
                    onChange={() => toggleAudience(opt.value)}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>

          <div className="template-mgmt__field">
            <label>Default Subject Line Prefix</label>
            <input
              type="text"
              value={form.fields.suggestedSubjectLine || ''}
              onChange={(e) =>
                setForm({ ...form, fields: { ...form.fields, suggestedSubjectLine: e.target.value } })
              }
              placeholder="e.g., [Ranger Newsletter]"
            />
          </div>

          <div className="template-mgmt__field">
            <label>Default Signature</label>
            <input
              type="text"
              value={form.fields.signatureText || ''}
              onChange={(e) =>
                setForm({ ...form, fields: { ...form.fields, signatureText: e.target.value } })
              }
              placeholder="e.g., Communications Cadre"
            />
          </div>

          <div className="template-mgmt__field">
            <label>Default Description</label>
            <textarea
              value={form.fields.description || ''}
              onChange={(e) =>
                setForm({ ...form, fields: { ...form.fields, description: e.target.value } })
              }
              placeholder="Pre-filled description text"
              rows={2}
            />
          </div>

          <div className="template-mgmt__field-row">
            <div className="template-mgmt__field">
              <label>Sort Order</label>
              <input
                type="number"
                value={form.sortOrder}
                onChange={(e) => setForm({ ...form, sortOrder: parseInt(e.target.value) || 0 })}
                min={0}
              />
            </div>
            <div className="template-mgmt__field">
              <label className="template-mgmt__checkbox-label">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) => setForm({ ...form, active: e.target.checked })}
                />
                Active
              </label>
            </div>
          </div>

          <div className="template-mgmt__actions">
            <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving || !form.name}>
              {saving ? 'Saving...' : editingId ? 'Update' : 'Create'}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={cancelForm}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {templates.length === 0 && !showAddForm ? (
        <div className="template-mgmt__empty">
          No templates yet. Click "Add Template" to create one.
        </div>
      ) : (
        <div className="template-mgmt__list">
          {templates.map((template) => (
            <div
              key={template.id}
              className={`template-mgmt__item ${!template.active ? 'template-mgmt__item--inactive' : ''}`}
            >
              <div className="template-mgmt__item-info">
                <div className="template-mgmt__item-name">
                  {template.name}
                  {!template.active && <span className="template-mgmt__badge--inactive">Inactive</span>}
                </div>
                <div className="template-mgmt__item-desc">{template.description}</div>
                {template.fields.audience && template.fields.audience.length > 0 && (
                  <div className="template-mgmt__item-audiences">
                    {template.fields.audience.map(a => (
                      <span key={a} className="template-mgmt__audience-tag">{a}</span>
                    ))}
                  </div>
                )}
              </div>
              <div className="template-mgmt__item-actions">
                <span className="template-mgmt__sort-order">#{template.sortOrder}</span>
                <button
                  className="btn btn-icon btn-sm btn-secondary"
                  onClick={() => startEdit(template)}
                  title="Edit"
                >
                  <i className="fas fa-pen" />
                </button>
                <button
                  className="btn btn-icon btn-sm btn-danger"
                  onClick={() => handleDelete(template.id)}
                  title="Delete"
                >
                  <i className="fas fa-trash" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default TemplateManagement;
