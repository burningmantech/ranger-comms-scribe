import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import MailingListsManager from '../components/MailingListsManager';
import TemplateManagement from '../components/TemplateManagement';
import './RequestSettings.css';

type Tab = 'lists' | 'templates';

/**
 * Requests → Lists & templates (Comms Cadre and Admins): the mailing lists announcements go to,
 * and the templates on the request form.
 */
export const RequestSettings: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.get('tab') === 'templates' ? 'templates' : 'lists');
  const choose = (next: Tab) => {
    setTab(next);
    setParams(next === 'lists' ? {} : { tab: next }, { replace: true });
  };

  return (
    <div className="request-settings">
      <div className="request-settings__head">
        <Link to="/requests" className="request-settings__back">← Requests</Link>
        <h1>Lists &amp; templates</h1>
      </div>
      <div className="request-settings__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'lists'} className={tab === 'lists' ? 'active' : ''} onClick={() => choose('lists')}>
          Mailing lists
        </button>
        <button type="button" role="tab" aria-selected={tab === 'templates'} className={tab === 'templates' ? 'active' : ''} onClick={() => choose('templates')}>
          Request templates
        </button>
      </div>
      <div className="request-settings__body">
        {tab === 'lists' ? <MailingListsManager /> : <TemplateManagement />}
      </div>
    </div>
  );
};

export default RequestSettings;
