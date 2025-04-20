import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { API_URL } from '../config';

declare global {
    interface Window {
        turnstile: {
            render: (container: string | HTMLElement, options: any) => string;
            reset: (widgetId: string) => void;
        };
    }
}

const ResetPassword: React.FC = () => {
    const [password, setPassword] = useState<string>('');
    const [confirmPassword, setConfirmPassword] = useState<string>('');
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<boolean>(false);
    const [validToken, setValidToken] = useState<boolean | null>(null);
    const [tokenValidationLoading, setTokenValidationLoading] = useState<boolean>(true);
    const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
    const turnstileWidgetId = useRef<string | null>(null);

    const navigate = useNavigate();
    const location = useLocation();

    // Extract token from URL query parameters
    useEffect(() => {
        const searchParams = new URLSearchParams(location.search);
        const token = searchParams.get('token');

        if (!token) {
            setError('Invalid reset link. No token provided.');
            setValidToken(false);
            setTokenValidationLoading(false);
            return;
        }

        // Validate the token before showing the form
        const validateToken = async () => {
            try {
                const response = await fetch(`${API_URL}/auth/validate-reset-token`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ token })
                });

                if (response.ok) {
                    setValidToken(true);
                } else {
                    const data = await response.json();
                    setError(data.error || 'Invalid or expired reset token');
                    setValidToken(false);
                }
            } catch (err) {
                setError('An error occurred while validating your reset token');
                setValidToken(false);
            } finally {
                setTokenValidationLoading(false);
            }
        };

        validateToken();
    }, [location]);

    useEffect(() => {
        if (validToken) {
            const loadTurnstileScript = () => {
                if (document.getElementById('turnstile-script')) {
                    renderTurnstile();
                    return;
                }
                
                const script = document.createElement('script');
                script.id = 'turnstile-script';
                script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
                script.async = true;
                script.defer = true;
                script.onload = () => {
                    console.log('Cloudflare Turnstile script loaded');
                    renderTurnstile();
                };
                script.onerror = () => {
                    console.error('Failed to load Cloudflare Turnstile script');
                };
                document.body.appendChild(script);
            };

            const renderTurnstile = () => {
                if (window.turnstile) {
                    turnstileWidgetId.current = window.turnstile.render('#turnstile-container', {
                        sitekey: '0x4AAAAAABPuI5DC6aoVeeXB',
                        theme: 'light',
                        callback: (token: string) => {
                            setTurnstileToken(token);
                        },
                        'error-callback': () => setTurnstileToken(null),
                        'expired-callback': () => setTurnstileToken(null),
                    });
                }
            };

            loadTurnstileScript();
            
            return () => {
                if (turnstileWidgetId.current && window.turnstile) {
                    window.turnstile.reset(turnstileWidgetId.current);
                }
            };
        }
    }, [validToken]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (password !== confirmPassword) {
            setError('Passwords do not match');
            return;
        }

        if (password.length < 8) {
            setError('Password must be at least 8 characters long');
            return;
        }

        if (!turnstileToken) {
            setError('Please complete the CAPTCHA');
            return;
        }

        const searchParams = new URLSearchParams(location.search);
        const token = searchParams.get('token');

        if (!token) {
            setError('No reset token provided');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const response = await fetch(`${API_URL}/auth/reset-password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    token,
                    password,
                    turnstileToken
                })
            });

            const data = await response.json();

            if (response.ok) {
                setSuccess(true);

                // Redirect to login page after a delay
                setTimeout(() => {
                    navigate('/login');
                }, 3000);
            } else {
                throw new Error(data.error || 'Failed to reset password');
            }
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    if (tokenValidationLoading) {
        return (
            <div style={{ maxWidth: '500px', margin: '0 auto', padding: '20px' }}>
                <h2>Password Reset</h2>
                <div style={{ padding: '15px', backgroundColor: '#e2e3e5', color: '#383d41', borderRadius: '4px' }}>
                    <p>Validating your reset link...</p>
                </div>
            </div>
        );
    }

    return (
        <div style={{ maxWidth: '500px', margin: '0 auto', padding: '20px' }}>
            <h2>Reset Your Password</h2>

            {!validToken ? (
                <div style={{ padding: '15px', backgroundColor: '#f8d7da', color: '#721c24', borderRadius: '4px', marginBottom: '20px' }}>
                    <p><strong>Error:</strong> {error || 'Invalid reset link'}</p>
                    <p>Please request a new password reset link.</p>
                    <button
                        onClick={() => navigate('/login')}
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
                        Go to Login
                    </button>
                </div>
            ) : success ? (
                <div style={{ padding: '15px', backgroundColor: '#d4edda', color: '#155724', borderRadius: '4px', marginBottom: '20px' }}>
                    <p><strong>Success!</strong> Your password has been reset.</p>
                    <p>You will be redirected to the login page in a few seconds.</p>
                    <button
                        onClick={() => navigate('/login')}
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
                        Go to Login
                    </button>
                </div>
            ) : (
                <div>
                    <p>Please enter your new password below.</p>

                    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                        <div>
                            <label htmlFor="password">New Password</label>
                            <input
                                type="password"
                                id="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                style={{ width: '100%', padding: '8px', marginTop: '5px' }}
                                minLength={8}
                            />
                        </div>

                        <div>
                            <label htmlFor="confirmPassword">Confirm Password</label>
                            <input
                                type="password"
                                id="confirmPassword"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                required
                                style={{ width: '100%', padding: '8px', marginTop: '5px' }}
                                minLength={8}
                            />
                        </div>

                        <div id="turnstile-container" style={{ marginBottom: '15px' }}></div>

                        {error && (
                            <div style={{ color: 'red', marginBottom: '10px' }}>
                                {error}
                            </div>
                        )}

                        <button 
                            type="submit" 
                            disabled={loading}
                            style={{
                                padding: '10px',
                                backgroundColor: '#1a73e8',
                                color: 'white',
                                border: 'none',
                                borderRadius: '5px',
                                cursor: loading ? 'not-allowed' : 'pointer',
                                opacity: loading ? 0.7 : 1
                            }}
                        >
                            {loading ? 'Resetting...' : 'Reset Password'}
                        </button>
                    </form>
                </div>
            )}
        </div>
    );
};

export default ResetPassword;