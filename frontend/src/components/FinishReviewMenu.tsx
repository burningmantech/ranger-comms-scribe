import React from 'react';
import Dropdown from 'react-bootstrap/Dropdown';
import './FinishReviewMenu.css';

/**
 * "Finish review ▾": the decision on the whole request, in one menu. The items call the
 * same handlers the separate Approve / Request Changes / Reject buttons did.
 * React-Bootstrap's Dropdown supplies the menu semantics: aria-expanded on the button,
 * arrow keys between items, Escape closes and returns focus to the button.
 */

interface FinishReviewMenuProps {
  onApprove: () => void;
  onRequestChanges: () => void;
  /** Declines the whole request (the former "Reject"; same endpoint). */
  onDecline: () => void;
}

const FinishReviewMenu: React.FC<FinishReviewMenuProps> = ({ onApprove, onRequestChanges, onDecline }) => (
  <Dropdown className="finish-review" align="end">
    <Dropdown.Toggle as="button" type="button" className="finish-review__toggle" id="finish-review-toggle">
      Finish review
    </Dropdown.Toggle>
    <Dropdown.Menu className="finish-review__menu">
      <Dropdown.Item as="button" type="button" className="finish-review__item finish-review__item--approve" onClick={onApprove}>
        <i className="fas fa-check" aria-hidden="true" />
        <span className="finish-review__item-text">
          <span className="finish-review__item-label">Approve</span>
          <span className="finish-review__item-hint">Approve this request</span>
        </span>
      </Dropdown.Item>
      <Dropdown.Item as="button" type="button" className="finish-review__item finish-review__item--request-changes" onClick={onRequestChanges}>
        <i className="fas fa-comment-dots" aria-hidden="true" />
        <span className="finish-review__item-text">
          <span className="finish-review__item-label">Request changes</span>
          <span className="finish-review__item-hint">Ask the submitter to revise it</span>
        </span>
      </Dropdown.Item>
      <Dropdown.Divider className="finish-review__divider" />
      <Dropdown.Item as="button" type="button" className="finish-review__item finish-review__item--decline" onClick={onDecline}>
        <i className="fas fa-times" aria-hidden="true" />
        <span className="finish-review__item-text">
          <span className="finish-review__item-label">Decline</span>
          <span className="finish-review__item-hint">Decline the whole request</span>
        </span>
      </Dropdown.Item>
    </Dropdown.Menu>
  </Dropdown>
);

export default FinishReviewMenu;
