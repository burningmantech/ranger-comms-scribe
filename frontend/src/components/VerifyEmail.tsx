import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { API_URL } from '../config';

const VerifyEmail: React.FC = () => {
  const [verifying, setVerifying] = useState<boolean>(true);
  const [success, setSuccess] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const verifyEmail = async () => {
      try {
        const searchParams = new URLSearchParams(location.search);
        const token = searchParams.get('token');
        
        if (!token) {
          setError('Invalid verification link. No token provided.');
          setVerifying(false);
          return;
        }
        
        const response = await fetch(`${API_URL}/auth/verify-email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ token }),
        });
        
        const data = await response.json();
        
        if (response.ok) {
          setSuccess(true);
          
          // If user is currently logged in, update their local storage data
          const userJson = localStorage.getItem('user');
          if (userJson) {
            try {
              const user = JSON.parse(userJson);
              user.emailVerified = true;
              localStorage.setItem('user', JSON.stringify(user));
            } catch (err) {
              console.error('Error updating local user data:', err);
            }
          }
        } else {
          setError(data.error || 'Failed to verify email');
        }
      } catch (err) {
        setError('An error occurred during email verification');
        console.error('Verification error:', err);
      } finally {
        setVerifying(false);
      }
    };

    verifyEmail();
  }, [location]);

  return (
    <div style={{ maxWidth: '500px', margin: '0 auto', padding: '20px' }}>
      <h2>Email Verification</h2>
      
      {verifying ? (
        <div style={{ padding: '15px', backgroundColor: '#e2e3e5', color: '#383d41', borderRadius: '4px' }}>
          <p>Verifying your email address...</p>
        </div>
      ) : success ? (
        <div style={{ padding: '15px', backgroundColor: '#d4edda', color: '#155724', borderRadius: '4px', marginBottom: '20px' }}>
          <p><strong>Success!</strong> Your email address has been verified.</p>
          <p>You can now access all features of the application.</p>
          <button
            onClick={() => navigate('/')}
            style={{
              padding: '8px 15px',
              backgroundColor: '#1a73e8',
              color: 'white',
              border: 'none',
              borderRadius: '5px',
              cursor: 'pointer',
              marginTop: '10px'
            }}
          >
            Go to Home
          </button>
        </div>
      ) : (
        <div style={{ padding: '15px', backgroundColor: '#f8d7da', color: '#721c24', borderRadius: '4px', marginBottom: '20px' }}>
          <p><strong>Error:</strong> {error || 'Failed to verify your email'}</p>
          <p>
            This could be because:
          </p>
          <ul>
            <li>The verification link has expired</li>
            <li>Your email has already been verified</li>
            <li>The verification token is invalid</li>
          </ul>
          <p>Please try logging in or request a new verification link.</p>
          <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
            <button
              onClick={() => navigate('/login')}
              style={{
                padding: '8px 15px',
                backgroundColor: '#1a73e8',
                color: 'white',
                border: 'none',
                borderRadius: '5px',
                cursor: 'pointer'
              }}
            >
              Go to Login
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default VerifyEmail;