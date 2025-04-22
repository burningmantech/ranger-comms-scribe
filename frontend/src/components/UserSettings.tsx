import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { User } from '../types';
import { API_URL } from '../config';
import Navbar from './Navbar';
import './UserSettings.css';

interface UserSettingsProps {
  skipNavbar?: boolean;
}

const UserSettings: React.FC<UserSettingsProps> = ({ skipNavbar = false }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  
  // Default to true for both notification settings
  const [notifyOnReplies, setNotifyOnReplies] = useState<boolean>(true);
  const [notifyOnGroupContent, setNotifyOnGroupContent] = useState<boolean>(true);
  
  const navigate = useNavigate();

  useEffect(() => {
    const userJson = localStorage.getItem('user');
    if (!userJson) {
      // If user is not logged in, redirect to login page
      navigate('/');
      return;
    }

    // Parse user data from localStorage
    try {
      const userData = JSON.parse(userJson);
      setUser(userData);
      
      // Fetch user settings from server to get the latest
      fetchUserSettings();
    } catch (err) {
      console.error('Error parsing user data:', err);
      setError('Failed to load user data. Please log in again.');
      setLoading(false);
    }
  }, [navigate]);

  const fetchUserSettings = async () => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/user/settings`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${sessionId}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch user settings');
      }

      const data = await response.json();
      
      // Set notification preferences from user data or default to true if not set
      setNotifyOnReplies(data.notificationSettings?.notifyOnReplies ?? true);
      setNotifyOnGroupContent(data.notificationSettings?.notifyOnGroupContent ?? true);
      
      // Update the user state with the latest data
      setUser(prevUser => ({
        ...prevUser!,
        notificationSettings: {
          notifyOnReplies: data.notificationSettings?.notifyOnReplies ?? true,
          notifyOnGroupContent: data.notificationSettings?.notifyOnGroupContent ?? true
        }
      }));
      
      setLoading(false);
    } catch (err) {
      console.error('Error fetching user settings:', err);
      
      // If we can't fetch settings, default to true for both
      setNotifyOnReplies(true);
      setNotifyOnGroupContent(true);
      
      // Don't show error, just use defaults
      setLoading(false);
    }
  };

  const saveSettings = async () => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      navigate('/');
      return;
    }

    try {
      setError(null);
      setSuccessMessage(null);
      
      const response = await fetch(`${API_URL}/user/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({
          notificationSettings: {
            notifyOnReplies,
            notifyOnGroupContent
          }
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to save settings');
      }

      // Update local user data
      if (user) {
        const updatedUser = {
          ...user,
          notificationSettings: {
            notifyOnReplies,
            notifyOnGroupContent
          }
        };
        
        setUser(updatedUser);
        localStorage.setItem('user', JSON.stringify(updatedUser));
      }

      setSuccessMessage('Your settings have been saved successfully');
      
      // Clear success message after 3 seconds
      setTimeout(() => {
        setSuccessMessage(null);
      }, 3000);
    } catch (err) {
      console.error('Error saving settings:', err);
      setError(err instanceof Error ? err.message : 'An error occurred while saving settings');
    }
  };

  if (loading) {
    return <div className="user-settings-container">Loading...</div>;
  }

  if (!user) {
    return <div className="user-settings-container">Please log in to view your settings.</div>;
  }

  return (
    <>
      {!skipNavbar && <Navbar />}
      <div className="user-settings-container">
        <div className="user-settings-header">
          <h1 className="user-settings-title">User Settings</h1>
        </div>

        {error && <div className="error-message">{error}</div>}
        {successMessage && <div className="success-message">{successMessage}</div>}

        <div className="card">
          <div className="card-header">
            <h2>Notification Preferences</h2>
          </div>
          <div className="card-body">
            <p>Manage how you receive email notifications from the platform.</p>
            
            <div className="form-group">
              <div className="custom-checkbox">
                <input
                  type="checkbox"
                  id="notifyOnReplies"
                  checked={notifyOnReplies}
                  onChange={(e) => setNotifyOnReplies(e.target.checked)}
                />
                <span className="checkbox-icon"></span>
                <label htmlFor="notifyOnReplies">Notify me when someone replies to my content</label>
              </div>
              <p className="mb-2 text-medium">
                Receive email notifications when someone replies to your posts, comments, or gallery items.
              </p>
              
              <div className="custom-checkbox">
                <input
                  type="checkbox"
                  id="notifyOnGroupContent"
                  checked={notifyOnGroupContent}
                  onChange={(e) => setNotifyOnGroupContent(e.target.checked)}
                />
                <span className="checkbox-icon"></span>
                <label htmlFor="notifyOnGroupContent">Notify me about new content in my groups</label>
              </div>
              <p className="text-medium">
                Receive email notifications when new content is posted in groups you belong to.
              </p>
            </div>
          </div>
          <div className="card-footer">
            <button className="btn btn-secondary" onClick={saveSettings}>
              Save Settings
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default UserSettings;