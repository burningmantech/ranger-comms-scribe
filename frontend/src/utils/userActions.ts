import { useNavigate } from 'react-router-dom';
import { API_URL } from '../config';
import { User, UserType } from '../types';

// Event to notify login state changes
export const USER_LOGIN_EVENT = 'user_login_change';

// Helper to dispatch login state change event
const dispatchLoginStateChange = (user: User | null) => {
    const event = new CustomEvent(USER_LOGIN_EVENT, { detail: user });
    window.dispatchEvent(event);
};

// Function to handle user login
export const handleUserLogin = async (userData: User, sessionId: string) => {
    // First, set default permissions based on roles
    const defaultPermissions = {
        canEdit: userData.roles.includes('Admin') || userData.roles.includes('CouncilManager') || userData.roles.includes('CommsCadre'),
        canApprove: userData.roles.includes('Admin') || userData.roles.includes('CouncilManager') || userData.roles.includes('CommsCadre'),
        canCreateSuggestions: userData.roles.includes('Admin') || userData.roles.includes('CouncilManager') || userData.roles.includes('CommsCadre'),
        canApproveSuggestions: userData.roles.includes('Admin') || userData.roles.includes('CouncilManager') || userData.roles.includes('CommsCadre'),
        canReviewSuggestions: userData.roles.includes('Admin') || userData.roles.includes('CouncilManager') || userData.roles.includes('CommsCadre')
    };
    localStorage.setItem('userPermissions', JSON.stringify(defaultPermissions));

    // Then fetch user roles from backend
    try {
        const response = await fetch(`${API_URL}/admin/user-roles`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${sessionId}`,
            },
        });

        if (response.ok) {
                  const data = await response.json();
            
            // Update both roles and userType based on the roles
            userData.roles = data.roles || [];
            userData.userType = userData.isAdmin ? UserType.Admin : 
                               data.roles.includes('CouncilManager') ? UserType.CouncilManager :
                               data.roles.includes('CommsCadre') ? UserType.CommsCadre :
                               data.roles.includes('Lead') ? UserType.Lead :
                               data.roles.includes('Member') ? UserType.Member :
                               UserType.Public;

            // Update permissions based on roles
            const updatedPermissions = {
                canEdit: data.roles.includes('Admin') || data.roles.includes('CouncilManager') || data.roles.includes('CommsCadre'),
                canApprove: data.roles.includes('Admin') || data.roles.includes('CouncilManager') || data.roles.includes('CommsCadre'),
                canCreateSuggestions: data.roles.includes('Admin') || data.roles.includes('CouncilManager') || data.roles.includes('CommsCadre'),
                canApproveSuggestions: data.roles.includes('Admin') || data.roles.includes('CouncilManager') || data.roles.includes('CommsCadre'),
                canReviewSuggestions: data.roles.includes('Admin') || data.roles.includes('CouncilManager') || data.roles.includes('CommsCadre')
            };
            localStorage.setItem('userPermissions', JSON.stringify(updatedPermissions));
        }
    } catch (error) {
        console.error('Error fetching user roles:', error);
    }

    localStorage.setItem('user', JSON.stringify(userData));
    localStorage.setItem('sessionId', sessionId);
    dispatchLoginStateChange(userData);
};

export const LogoutUserReact = async (navigate?: (path: string) => void) => {
    const sessionId = localStorage.getItem('sessionId');
    await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionId}`,
      },
    });
    localStorage.removeItem('user');
    localStorage.removeItem('sessionId');
    dispatchLoginStateChange(null);


    if (navigate) {
        navigate('/'); // Redirect to home page if navigate function is provided
    }
};
