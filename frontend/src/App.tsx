import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import Login from './components/Login';
import Admin from './components/Admin';
import ResetPassword from './components/ResetPassword';
import VerifyEmail from './components/VerifyEmail';
import { User } from './types';
import Home from './components/Home';
import { API_URL } from './config';
import Navbar from './components/Navbar';
import { USER_LOGIN_EVENT } from './utils/userActions';
import IndentationTest from './components/editor/tests/IndentationTest';
import CheckboxTest from './components/editor/tests/CheckboxTest';
import LexicalExtractionTest from './components/editor/tests/LexicalExtractionTest';
import { MySubmissions } from './pages/MySubmissions';
import { TrackedChangesView } from './pages/TrackedChangesView';
import { TrackedChangesDemo } from './pages/TrackedChangesDemo';
import { ContentProvider } from './contexts/ContentContext';
import CommsRequest from './components/CommsRequest';
import { ProtectedRoute } from './components/ProtectedRoute';
import { NewsletterEditions } from './pages/NewsletterEditions';
import { NewsletterEditor } from './pages/NewsletterEditor';
import { NewsletterArchive, PublicEdition, PublicDocument } from './pages/PublicNewsletter';
import { canSendAnnouncements, canUseNewsletter, isReviewer } from './utils/access';
import { CommsCalendar } from './pages/CommsCalendar';
import { RequestSettings } from './pages/RequestSettings';
import { FeedbackCarrot } from './components/FeedbackCarrot';

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    // Check if user is logged in
    const userJson = localStorage.getItem('user');
    if (userJson) {
      try {
        const userData = JSON.parse(userJson) as User;
        setUser(userData);
      } catch (err) {
        console.error('Error parsing user data:', err);
      }
    }

    // Listen for login state changes
    const handleLoginStateChange = (event: CustomEvent<User | null>) => {
      const userData = event.detail;
      setUser(userData);
    };

    window.addEventListener(USER_LOGIN_EVENT, handleLoginStateChange as EventListener);

    setLoading(false);

    return () => {
      window.removeEventListener(USER_LOGIN_EVENT, handleLoginStateChange as EventListener);
    };
  }, []);

  return (
    <ContentProvider>
      <Router>
        <div className="app-container">
          <Navbar />
          
          <div className="content-container">
            {loading ? (
              <div className="loading-container">Loading...</div>
            ) : (
              <Routes>
                <Route path="/" element={<Navigate to="/requests" replace />} />
                <Route path="/login" element={<Login skipNavbar={true} setParentUser={setUser} />} />
                <Route path="/admin" element={<Admin skipNavbar={true} />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route path="/verify-email" element={<VerifyEmail />} />
                <Route path="/test-indentation" element={<IndentationTest />} />
                <Route path="/checkbox-test" element={<CheckboxTest />} />
                <Route path="/lexical-extraction-test" element={<LexicalExtractionTest />} />
                {/* Any signed-in user (Members and Leads included): the backend authorizes each request */}
                <Route path="/requests" element={<ProtectedRoute element={<MySubmissions />} />} />
                <Route path="/requests/settings" element={<ProtectedRoute element={<RequestSettings />} allow={canSendAnnouncements} />} />
                <Route path="/comms-request" element={<ProtectedRoute element={<CommsRequest />} />} />
                <Route path="/tracked-changes/:submissionId" element={<ProtectedRoute element={<TrackedChangesView />} />} />
                <Route path="/tracked-changes-demo" element={<ProtectedRoute element={<TrackedChangesDemo />} />} />
                {/* Newsletter editions: the Comms Cadre, the Communications Manager and Admins */}
                <Route path="/newsletter/editions" element={<ProtectedRoute element={<NewsletterEditions />} allow={canUseNewsletter} />} />
                <Route path="/newsletter/editions/:id" element={<ProtectedRoute element={<NewsletterEditor />} allow={canUseNewsletter} />} />
                {/* Public (no sign-in): sent editions and their Read more pages */}
                <Route path="/newsletter" element={<NewsletterArchive />} />
                <Route path="/newsletter/:number" element={<PublicEdition />} />
                <Route path="/news/:slug" element={<PublicDocument />} />
                {/* Comms Cadre and Council; the backend decides who can edit */}
                <Route
                  path="/comms-calendar"
                  element={<ProtectedRoute element={<CommsCalendar />} allow={isReviewer} />}
                />

                {/* Final catch-all if nothing else matches */}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            )}
          </div>
          {/* The feedback tab on the right edge, for whoever an Admin turned it on for */}
          <FeedbackCarrot signedInAs={user?.email || null} />
        </div>
      </Router>
    </ContentProvider>
  );
};

export default App;
