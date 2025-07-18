import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import Login from './components/Login';
import Admin from './components/Admin';
import UserSettings from './components/UserSettings';
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
import { ContentManagement } from './pages/ContentManagement';
import { MySubmissions } from './pages/MySubmissions';
import { TrackedChangesView } from './pages/TrackedChangesView';
import { TrackedChangesDemo } from './pages/TrackedChangesDemo';
import { ContentProvider } from './contexts/ContentContext';
import CommsRequest from './components/CommsRequest';

// Protected Route component
const ProtectedRoute: React.FC<{
  element: React.ReactElement;
  allowedRoles: string[];
}> = ({ element, allowedRoles }) => {
  const userJson = localStorage.getItem('user');
  if (!userJson) {
    return <Navigate to="/login" replace />;
  }

  try {
    const user = JSON.parse(userJson);
    // Check if user is admin or has an allowed user type
    const hasAllowedRole = user.isAdmin || allowedRoles.includes(user.userType);
    return hasAllowedRole ? element : <Navigate to="/" replace />;
  } catch (err) {
    console.error('Error parsing user data:', err);
    return <Navigate to="/login" replace />;
  }
};

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    // Check if user is logged in
    const userJson = localStorage.getItem('user');
    if (userJson) {
      try {
        const userData = JSON.parse(userJson) as User;
        setUser(userData);
        setIsAdmin(userData.isAdmin === true || userData.userType === 'Admin');
      } catch (err) {
        console.error('Error parsing user data:', err);
      }
    }

    // Listen for login state changes
    const handleLoginStateChange = (event: CustomEvent<User | null>) => {
      const userData = event.detail;
      setUser(userData);
      setIsAdmin(userData?.isAdmin === true || userData?.userType === 'Admin');
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
                <Route path="/settings" element={<UserSettings skipNavbar={true} />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route path="/verify-email" element={<VerifyEmail />} />
                <Route path="/test-indentation" element={<IndentationTest />} />
                <Route path="/checkbox-test" element={<CheckboxTest />} />
                <Route path="/lexical-extraction-test" element={<LexicalExtractionTest />} />
                <Route 
                  path="/requests" 
                  element={
                    <ProtectedRoute 
                      element={<MySubmissions />} 
                      allowedRoles={['ADMIN', 'CommsCadre', 'CouncilManager', 'USER', 'Public']} 
                    />
                  } 
                />
                <Route 
                  path="/comms-request" 
                  element={
                    <ProtectedRoute 
                      element={<CommsRequest />} 
                      allowedRoles={['ADMIN', 'CommsCadre', 'CouncilManager', 'USER', 'Public']} 
                    />
                  } 
                />
                <Route 
                  path="/tracked-changes/:submissionId" 
                  element={
                    <ProtectedRoute 
                      element={<TrackedChangesView />} 
                      allowedRoles={['ADMIN', 'CommsCadre', 'CouncilManager', 'USER', 'Public']} 
                    />
                  } 
                />
                <Route 
                  path="/tracked-changes-demo" 
                  element={
                    <ProtectedRoute 
                      element={<TrackedChangesDemo />} 
                      allowedRoles={['ADMIN', 'CommsCadre', 'CouncilManager', 'USER', 'Public']} 
                    />
                  } 
                />
                
                {/* Final catch-all if nothing else matches */}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            )}
          </div>
        </div>
      </Router>
    </ContentProvider>
  );
};

export default App;
