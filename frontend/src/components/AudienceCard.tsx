import React from 'react';
import './AudienceCard.css';

interface AudienceCardProps {
  id: string;
  label: string;
  description: string;
  icon: string;
  selected: boolean;
  onToggle: () => void;
}

const AudienceCard: React.FC<AudienceCardProps> = ({
  id,
  label,
  description,
  icon,
  selected,
  onToggle,
}) => (
  <button
    type="button"
    className={`audience-card ${selected ? 'audience-card--selected' : ''}`}
    onClick={onToggle}
    aria-pressed={selected}
  >
    <div className="audience-card__icon">
      <i className={icon} />
    </div>
    <div className="audience-card__content">
      <div className="audience-card__label">{label}</div>
      <div className="audience-card__desc">{description}</div>
    </div>
    <div className="audience-card__check">
      {selected && <i className="fas fa-check" />}
    </div>
  </button>
);

export default AudienceCard;
