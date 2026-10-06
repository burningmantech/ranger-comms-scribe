import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_URL } from '../config';
import './Admin.css';
import './RoleManagement.css';
import Navbar from './Navbar';
import { PeopleManagement } from './PeopleManagement';

interface AdminProps {
  skipNavbar?: boolean;
}

/**
 * The admin area: People (who can sign in, and their roles). Mailing lists and request templates
 * are under Requests → Lists & templates; approval reminders are on each request's review page.
 */
const Admin: React.FC<AdminProps> = ({ skipNavbar }) => {
  const [status, setStatus] = useState<'checking' | 'admin' | 'denied'>('checking');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }
    fetch(`${API_URL}/admin/check`, { headers: { Authorization: `Bearer ${sessionId}` } })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('Not authorized'))))
      .then((data) => {
        if (data.isAdmin) {
          setStatus('admin');
        } else {
          setStatus('denied');
          setError('You do not have admin privileges');
          setTimeout(() => navigate('/'), 3000);
        }
      })
      .catch(() => {
        setStatus('denied');
        setError('Error checking admin status');
        setTimeout(() => navigate('/'), 3000);
      });
  }, [navigate]);

  if (status !== 'admin') {
    return <div className="admin-container">{error ? <div className="error-message">{error}</div> : <div>Checking access…</div>}</div>;
  }

  return (
    <div className="admin-container">
      {!skipNavbar && <Navbar />}
      <div className="admin-content">
        <PeopleManagement />
      </div>
    </div>
  );
};

export default Admin;
