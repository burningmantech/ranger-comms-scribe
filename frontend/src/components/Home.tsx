import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';

interface HomeProps {
  skipNavbar?: boolean;
}

const Home: React.FC<HomeProps> = ({ skipNavbar }) => {
    const [isAdmin, setIsAdmin] = useState<boolean>(false);

    useEffect(() => {
        // Check if the user is an admin
        const userJson = localStorage.getItem('user');
        if (userJson) {
            try {
                const userData = JSON.parse(userJson);
                setIsAdmin(userData.isAdmin === true || userData.userType === 'Admin');
            } catch (err) {
                console.error('Error parsing user data:', err);
            }
        }
    }, []);

    return (
        <div className="home">
            <h1>Welcome to Comms Scribe</h1>
            <p>Check out our <Link to="/gallery">Gallery</Link>.</p>
        </div>
    );
};

export default Home;
