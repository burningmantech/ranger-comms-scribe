import React from 'react';
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import Blog from './components/Blog';
import Gallery from './components/Gallery';
import Login from './components/Login';

const App: React.FC = () => {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Login />} />
        <Route path="/blog" element={<Blog />} />
        <Route path="/gallery" element={<Gallery />} />
      </Routes>
    </Router>
  );
};

export default App;