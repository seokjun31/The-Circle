import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import Header from './components/Header';
import UploadPage from './pages/UploadPage';
import StyleSelectPage from './pages/StyleSelectPage';
import MaskingPage from './pages/MaskingPage';
import ResultPage from './pages/ResultPage';
import './styles/global.css';

function App() {
  return (
    <Router>
      <div className="app">
        <Header />
        <main className="main-content">
          <Routes>
            <Route path="/" element={<UploadPage />} />
            <Route path="/style" element={<StyleSelectPage />} />
            <Route path="/mask" element={<MaskingPage />} />
            <Route path="/result" element={<ResultPage />} />
          </Routes>
        </main>
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 4000,
            style: {
              background: '#1e1e2e',
              color: '#cdd6f4',
              border: '1px solid #313244',
            },
          }}
        />
      </div>
    </Router>
  );
}

export default App;
