import React, { useState, useEffect } from 'react';
import Navbar from './Navbar';


import { User } from '../types';

const Home: React.FC = () => {
    const [user, setUser] = useState<User | null>(null);

    return (
        <>
        <Navbar />
        <div className="home">
        <h1>Welcome to Dancing Cat Wine Bar</h1>
        <p>Check out our <a href="/gallery">Gallery</a> and <a href="/blog">Blog</a>.</p>
        </div>
        </>
    );
    }

export default Home;