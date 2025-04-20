import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { GOOGLE_CLIENT_ID, API_URL } from '../config';
import { handleGoogleCredentialResponse } from '../utils/googleAuth';
import { fetchBlogContent, LogoutUserReact, handleUserLogin } from '../utils/userActions';
import LoggedOutView from './LoggedOutView';
import Home from './Home';
import { User } from '../types';

declare global {
    interface Window {
        google: any;
        turnstile: {
            render: (container: string | HTMLElement, options: any) => string;
            reset: (widgetId: string) => void;
        };
    }
}

interface LoginProps {
    skipNavbar?: boolean;
    setParentUser: React.Dispatch<React.SetStateAction<User | null>>;
}

interface LoginFormData {
    email: string;
    password: string;
    name?: string;
    confirmPassword?: string;
}

type AuthMode = 'login' | 'register' | 'forgotPassword';

interface PasswordRequirement {
    label: string;
    test: (password: string) => boolean;
    met: boolean;
}

const Login: React.FC<LoginProps> = ({ skipNavbar, setParentUser }) => {
    const [user, setUser] = useState<User | null>(null);
    const [blogContent, setBlogContent] = useState<string | null>(null);
    const [authMode, setAuthMode] = useState<AuthMode>('login');
    const [formData, setFormData] = useState<LoginFormData>({ 
        email: '', 
        password: '', 
        name: '',
        confirmPassword: '' 
    });
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [loading, setLoading] = useState<boolean>(false);
    const [passwordRequirements, setPasswordRequirements] = useState<PasswordRequirement[]>([
        { label: 'At least 8 characters long', test: (p) => p.length >= 8, met: false },
        { label: 'Contains uppercase letter', test: (p) => /[A-Z]/.test(p), met: false },
        { label: 'Contains lowercase letter', test: (p) => /[a-z]/.test(p), met: false },
        { label: 'Contains number', test: (p) => /[0-9]/.test(p), met: false },
        { label: 'Contains special character', test: (p) => /[^A-Za-z0-9]/.test(p), met: false }
    ]);
    const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
    const turnstileWidgetId = useRef<string | null>(null);
    const navigate = useNavigate();

    useEffect(() => {
        const storedUser = localStorage.getItem('user');
        console.log('Checking localStorage for user:', storedUser);
        if (storedUser) {
            const parsedUser = JSON.parse(storedUser);
            console.log('User found in localStorage:', parsedUser);
            setUser(parsedUser);
        } else {
            console.log('No user found in localStorage');
        }
    }, []);

    useEffect(() => {
        if (user) {
            if (window.google && window.google.accounts) {
                window.google.accounts.id.cancel();
                console.log('Google One Tap canceled because user is logged in');
            }
            return;
        }

        const loadGoogleScript = () => {
            const script = document.createElement('script');
            script.src = 'https://accounts.google.com/gsi/client';
            script.async = true;
            script.defer = true;
            script.onload = () => {
                console.log('Google Identity Services script loaded');
                if (window.google) {
                    console.log('Google object is available');
                    window.google.accounts.id.initialize({
                        client_id: GOOGLE_CLIENT_ID,
                        callback: (response: any) =>
                            handleGoogleCredentialResponse(response, setUser, setParentUser),
                    });

                    window.google.accounts.id.prompt((notification: any) => {
                        if (notification.isNotDisplayed()) {
                            console.error('One Tap Login not displayed:', notification.getNotDisplayedReason());
                        }
                        if (notification.isSkippedMoment()) {
                            console.error('One Tap Login skipped:', notification.getSkippedReason());
                        }
                        if (notification.isDismissedMoment()) {
                            console.error('One Tap Login dismissed:', notification.getDismissedReason());
                        }
                    });

                    const buttonContainer = document.getElementById('google-signin-button');
                    if (buttonContainer) {
                        console.log('Button container exists');
                        window.google.accounts.id.renderButton(buttonContainer, {
                            theme: 'filled_blue',
                            size: 'large',
                            shape: 'pill',
                            text: 'signin_with',
                            logo_alignment: 'left',
                        });
                    } else {
                        console.error('Button container does not exist');
                    }
                }
            };
            script.onerror = () => {
                console.error('Failed to load Google Identity Services script');
            };
            document.body.appendChild(script);
        };

        if (!window.google) {
            loadGoogleScript();
        } else {
            console.log('Google script already loaded');
            window.google.accounts.id.initialize({
                client_id: GOOGLE_CLIENT_ID,
                callback: (response: any) =>
                    handleGoogleCredentialResponse(response, setUser, setParentUser),
            });

            if (!user) {
                console.log('User not logged in, showing One Tap Login');
                window.google.accounts.id.prompt((notification: any) => {
                    if (notification.isNotDisplayed()) {
                        console.error('One Tap Login not displayed:', notification.getNotDisplayedReason());
                    }
                    if (notification.isSkippedMoment()) {
                        console.error('One Tap Login skipped:', notification.getSkippedReason());
                    }
                    if (notification.isDismissedMoment()) {
                        console.error('One Tap Login dismissed:', notification.getDismissedReason());
                    }
                });
            } else {
                console.log('User already logged in, not showing One Tap Login');
                window.google.accounts.id.cancel();
            }

            const buttonContainer = document.getElementById('google-signin-button');
            if (buttonContainer) {
                window.google.accounts.id.renderButton(buttonContainer, {
                    theme: 'filled_blue',
                    size: 'large',
                    shape: 'pill',
                    text: 'signin_with',
                    logo_alignment: 'left',
                });
            }
        }
    }, [user]);

    useEffect(() => {
        if (user) {
            navigate('/blog');
        }
    }, [user]);

    useEffect(() => {
        const loadTurnstileScript = () => {
            const script = document.createElement('script');
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
            const container = document.getElementById('turnstile-container');
            if (container && window.turnstile) {
                if (turnstileWidgetId.current) {
                    window.turnstile.reset(turnstileWidgetId.current);
                }
                turnstileWidgetId.current = window.turnstile.render(container, {
                    sitekey: '0x4AAAAAABPuI5DC6aoVeeXB',
                    theme: 'light',
                    callback: function(token: string) {
                        console.log('Turnstile token received');
                        // Store token in form data
                        setTurnstileToken(token);
                    },
                });
            }
        };

        if (!window.turnstile) {
            loadTurnstileScript();
        } else {
            renderTurnstile();
        }

        // Reset Turnstile when auth mode changes
        return () => {
            if (turnstileWidgetId.current && window.turnstile) {
                window.turnstile.reset(turnstileWidgetId.current);
            }
        };
    }, [authMode]);

    const checkPasswordRequirements = (password: string) => {
        setPasswordRequirements(prev => 
            prev.map(req => ({
                ...req,
                met: req.test(password)
            }))
        );
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        setFormData({
            ...formData,
            [name]: value
        });
        if (name === 'password') {
            checkPasswordRequirements(value);
        }
        setError(null);
        setMessage(null);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        setMessage(null);
        
        try {
            if (authMode === 'register') {
                if (!formData.name) {
                    throw new Error('Name is required');
                }
                if (formData.password !== formData.confirmPassword) {
                    throw new Error('Passwords do not match');
                }
                if (!passwordRequirements.every(r => r.met)) {
                    throw new Error('Password does not meet all requirements');
                }
                
                const response = await fetch(`${API_URL}/auth/register`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        name: formData.name,
                        email: formData.email,
                        password: formData.password,
                        turnstileToken,
                    }),
                });
                
                const data = await response.json();
                
                if (!response.ok) {
                    throw new Error(data.error || 'Registration failed');
                }
                
                const userData = {
                    email: data.email,
                    name: data.name,
                    isAdmin: data.isAdmin || false,
                    approved: data.approved || false
                };
                
                handleUserLogin(userData, data.sessionId);
                setUser(userData);
                setParentUser(userData);
                
                if (data.isAdmin) {
                    navigate('/admin');
                }
            } else if (authMode === 'forgotPassword') {
                if (!formData.email) {
                    throw new Error('Email address is required');
                }

                if (!turnstileToken) {
                    throw new Error('Please complete the security check');
                }

                const response = await fetch(`${API_URL}/auth/forgot-password`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        email: formData.email,
                        turnstileToken,
                    }),
                });
                
                const data = await response.json();
                
                if (!response.ok) {
                    throw new Error(data.error || 'Failed to process request');
                }
                
                setMessage(data.message || 'Password reset link has been sent to your email');
                
                setFormData({...formData, email: ''});
                // Reset turnstile after successful password reset request
                if (turnstileWidgetId.current && window.turnstile) {
                    window.turnstile.reset(turnstileWidgetId.current);
                    setTurnstileToken(null);
                }
            } else {
                const response = await fetch(`${API_URL}/auth/login`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        email: formData.email,
                        password: formData.password,
                        turnstileToken,
                    }),
                });
                
                const data = await response.json();
                
                if (!response.ok) {
                    throw new Error(data.error || 'Login failed');
                }
                
                const userData = {
                    email: data.email,
                    name: data.name,
                    isAdmin: data.isAdmin || false,
                    approved: data.approved || false
                };
                
                handleUserLogin(userData, data.sessionId);
                setUser(userData);
                setParentUser(userData);
                
                if (data.isAdmin) {
                    navigate('/admin');
                }
            }
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    const toggleAuthMode = (mode: AuthMode) => {
        setAuthMode(mode);
        setError(null);
        setMessage(null);
    };

    const handleLogout = () => {
        LogoutUserReact(navigate);
    };

    const renderForgotPasswordForm = () => {
        return (
            <div>
                <h3>Forgot Password</h3>
                <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                    <div>
                        <label htmlFor="email">Email</label>
                        <input
                            type="email"
                            id="email"
                            name="email"
                            value={formData.email}
                            onChange={handleInputChange}
                            required
                            style={{ width: '100%', padding: '8px', marginTop: '5px' }}
                        />
                    </div>
                    
                    <div id="turnstile-container" style={{ marginBottom: '15px' }}></div>
                    
                    {error && (
                        <div style={{ color: 'red', marginBottom: '10px' }}>
                            {error}
                        </div>
                    )}
                    
                    {message && (
                        <div style={{ color: 'green', marginBottom: '10px' }}>
                            {message}
                        </div>
                    )}
                    
                    <button 
                        type="submit" 
                        disabled={loading || !turnstileToken}
                        style={{
                            padding: '10px',
                            backgroundColor: '#1a73e8',
                            color: 'white',
                            border: 'none',
                            borderRadius: '5px',
                            cursor: loading || !turnstileToken ? 'not-allowed' : 'pointer',
                            opacity: loading || !turnstileToken ? 0.7 : 1
                        }}
                    >
                        {loading ? 'Sending...' : 'Send Reset Link'}
                    </button>
                </form>
                
                <p style={{ marginTop: '15px' }}>
                    <button 
                        onClick={() => toggleAuthMode('login')}
                        style={{
                            backgroundColor: 'transparent',
                            border: 'none',
                            color: '#1a73e8',
                            cursor: 'pointer',
                            padding: 0,
                            textDecoration: 'underline',
                            fontSize: 'inherit'
                        }}
                    >
                        Back to Sign in
                    </button>
                </p>
            </div>
        );
    };

    const renderPasswordRequirements = () => {
        if (authMode !== 'register' || !formData.password) return null;

        return (
            <div style={{ marginTop: '10px', fontSize: '14px' }}>
                <p style={{ marginBottom: '5px', color: '#666' }}>Password requirements:</p>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {passwordRequirements.map((req, index) => (
                        <li 
                            key={index}
                            style={{ 
                                display: 'flex',
                                alignItems: 'center',
                                color: req.met ? '#4caf50' : '#666',
                                marginBottom: '3px'
                            }}
                        >
                            <span style={{ 
                                marginRight: '8px',
                                fontSize: '18px'
                            }}>
                                {req.met ? '✓' : '○'}
                            </span>
                            {req.label}
                        </li>
                    ))}
                </ul>
            </div>
        );
    };

    const renderAuthForm = () => {
        if (authMode === 'forgotPassword') {
            return renderForgotPasswordForm();
        }

        return (
            <div>
                <h3>{authMode === 'login' ? 'Sign in' : 'Create an account'}</h3>

                <div
                    id="google-signin-button"
                    style={{
                        display: 'flex',
                        justifyContent: 'left',
                        marginBottom: '20px'
                    }}
                ></div>

                <div style={{ display: 'flex', alignItems: 'center', margin: '15px 0' }}>
                    <div style={{ flex: 1, height: '1px', backgroundColor: '#ccc' }}></div>
                    <p style={{ margin: '0 10px', color: '#666' }}>OR</p>
                    <div style={{ flex: 1, height: '1px', backgroundColor: '#ccc' }}></div>
                </div>
                
                <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                    {authMode === 'register' && (
                        <div>
                            <label htmlFor="name">Name</label>
                            <input
                                type="text"
                                id="name"
                                name="name"
                                value={formData.name}
                                onChange={handleInputChange}
                                required
                                style={{ width: '100%', padding: '8px', marginTop: '5px' }}
                            />
                        </div>
                    )}
                    
                    <div>
                        <label htmlFor="email">Email</label>
                        <input
                            type="email"
                            id="email"
                            name="email"
                            value={formData.email}
                            onChange={handleInputChange}
                            required
                            style={{ width: '100%', padding: '8px', marginTop: '5px' }}
                        />
                    </div>
                    
                    <div>
                        <label htmlFor="password">Password</label>
                        <input
                            type="password"
                            id="password"
                            name="password"
                            value={formData.password}
                            onChange={handleInputChange}
                            required
                            style={{
                                width: '100%',
                                padding: '8px',
                                marginTop: '5px',
                                borderColor: authMode === 'register' && formData.password 
                                    ? passwordRequirements.every(r => r.met) 
                                        ? '#4caf50' 
                                        : '#ff9800'
                                    : undefined,
                                borderWidth: '1px',
                                borderStyle: 'solid'
                            }}
                        />
                        {renderPasswordRequirements()}
                    </div>
                    
                    {authMode === 'register' && (
                        <div>
                            <label htmlFor="confirmPassword">Confirm Password</label>
                            <input
                                type="password"
                                id="confirmPassword"
                                name="confirmPassword"
                                value={formData.confirmPassword}
                                onChange={handleInputChange}
                                required
                                style={{
                                    width: '100%',
                                    padding: '8px',
                                    marginTop: '5px',
                                    borderColor: formData.confirmPassword 
                                        ? formData.password === formData.confirmPassword 
                                            ? '#4caf50' 
                                            : '#f44336'
                                        : undefined,
                                    borderWidth: '1px',
                                    borderStyle: 'solid'
                                }}
                            />
                            {formData.confirmPassword && formData.password !== formData.confirmPassword && (
                                <div style={{ color: '#f44336', fontSize: '14px', marginTop: '5px' }}>
                                    Passwords do not match
                                </div>
                            )}
                        </div>
                    )}
                    
                    <div id="turnstile-container" style={{ marginBottom: '15px' }}></div>
                    
                    {error && (
                        <div style={{ color: '#f44336', marginBottom: '10px' }}>
                            {error}
                        </div>
                    )}
                    
                    <button 
                        type="submit" 
                        disabled={loading || (authMode === 'register' && (!passwordRequirements.every(r => r.met) || formData.password !== formData.confirmPassword))}
                        style={{
                            padding: '10px',
                            backgroundColor: '#1a73e8',
                            color: 'white',
                            border: 'none',
                            borderRadius: '5px',
                            cursor: loading ? 'not-allowed' : 'pointer',
                            opacity: loading || (authMode === 'register' && (!passwordRequirements.every(r => r.met) || formData.password !== formData.confirmPassword)) ? 0.7 : 1
                        }}
                    >
                        {loading 
                            ? 'Processing...' 
                            : authMode === 'login' 
                                ? 'Sign in' 
                                : 'Create account'
                        }
                    </button>
                </form>
                
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '15px' }}>
                    <p>
                        {authMode === 'login' 
                            ? "Don't have an account? " 
                            : "Already have an account? "
                        }
                        <button 
                            onClick={() => toggleAuthMode(authMode === 'login' ? 'register' : 'login')}
                            style={{
                                backgroundColor: 'transparent',
                                border: 'none',
                                color: '#1a73e8',
                                cursor: 'pointer',
                                padding: 0,
                                textDecoration: 'underline',
                                fontSize: 'inherit'
                            }}
                        >
                            {authMode === 'login' ? 'Sign up' : 'Sign in'}
                        </button>
                    </p>
                    
                    {authMode === 'login' && (
                        <p>
                            <button 
                                onClick={() => toggleAuthMode('forgotPassword')}
                                style={{
                                    backgroundColor: 'transparent',
                                    border: 'none',
                                    color: '#1a73e8',
                                    cursor: 'pointer',
                                    padding: 0,
                                    textDecoration: 'underline',
                                    fontSize: 'inherit'
                                }}
                            >
                                Forgot password?
                            </button>
                        </p>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div>
            <h2>Login</h2>
            {user ? (
                <>
                    <div style={{ marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                            <p>Logged in as: <strong>{user.name}</strong> ({user.email})</p>
                            {user.isAdmin && <p><em>Administrator account</em></p>}
                        </div>
                        <button 
                            onClick={handleLogout}
                            style={{
                                padding: '8px 15px',
                                backgroundColor: '#f44336',
                                color: 'white',
                                border: 'none',
                                borderRadius: '5px',
                                cursor: 'pointer'
                            }}
                        >
                            Logout
                        </button>
                    </div>
                    <Home skipNavbar={skipNavbar} />
                </>
            ) : (
                <div>
                    <LoggedOutView />
                    
                    <div style={{ marginTop: '20px', maxWidth: '400px' }}>
                        {renderAuthForm()}
                    </div>
                </div>
            )}
        </div>
    );
};

export default Login;
