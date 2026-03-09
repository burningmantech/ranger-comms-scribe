import React from 'react';
import './FormSummarySidebar.css';

interface FormSummarySidebarProps {
  title?: string;
  description?: string;
  audience?: string[];
  audienceLabels: Record<string, string>;
  publishBy?: string;
  urgent?: boolean;
  replyTo?: string;
  signature?: string;
  approvers?: string[];
  hasContent?: boolean;
}

const FormSummarySidebar: React.FC<FormSummarySidebarProps> = ({
  title,
  description,
  audience,
  audienceLabels,
  publishBy,
  urgent,
  replyTo,
  signature,
  approvers,
  hasContent,
}) => {
  const formatDate = (dateStr: string): string => {
    if (!dateStr) return '';
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <aside className="form-summary">
      <div className="form-summary__header">Summary</div>
      <div className="form-summary__body">
        <SummaryRow label="Subject" value={title} />
        <SummaryRow label="Description" value={description ? (description.length > 80 ? description.substring(0, 80) + '...' : description) : undefined} />
        <SummaryRow label="Content" value={hasContent ? 'Rich text provided' : undefined} />
        {audience && audience.length > 0 && (
          <div className="form-summary__row">
            <span className="form-summary__label">Audience</span>
            <div className="form-summary__tags">
              {audience.map(a => (
                <span key={a} className="form-summary__tag">{audienceLabels[a] || a}</span>
              ))}
            </div>
          </div>
        )}
        <SummaryRow label="Publish by" value={publishBy ? formatDate(publishBy) : undefined} badge={urgent ? 'Urgent' : undefined} />
        <SummaryRow label="Reply-to" value={replyTo} />
        <SummaryRow label="Signature" value={signature} />
        {approvers && approvers.filter(a => a.trim()).length > 0 && (
          <div className="form-summary__row">
            <span className="form-summary__label">Approvers</span>
            <div className="form-summary__value">
              {approvers.filter(a => a.trim()).map((a, i) => (
                <div key={i} className="form-summary__approver">{a}</div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};

const SummaryRow: React.FC<{ label: string; value?: string; badge?: string }> = ({ label, value, badge }) => {
  if (!value) return null;
  return (
    <div className="form-summary__row">
      <span className="form-summary__label">{label}</span>
      <span className="form-summary__value">
        {value}
        {badge && <span className="form-summary__badge">{badge}</span>}
      </span>
    </div>
  );
};

export default FormSummarySidebar;
