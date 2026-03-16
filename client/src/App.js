import React from 'react';
import { BrowserRouter as Router, Routes, Route, useLocation } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider } from './contexts/AuthContext';
import Header from './components/Header';
import ProtectedRoute from './components/ProtectedRoute';

// Pages
import LandingPage       from './pages/LandingPage';
import DashboardPage     from './pages/DashboardPage';
import UploadPage        from './pages/UploadPage';
import StyleSelectPage   from './pages/StyleSelectPage';
import MaskingPage       from './pages/MaskingPage';
import ResultPage        from './pages/ResultPage';
import EditorPage        from './pages/EditorPage';
import FurniturePage     from './pages/FurniturePage';
import LoginPage         from './pages/LoginPage';
import RegisterPage      from './pages/RegisterPage';
import OAuthCallbackPage from './pages/OAuthCallbackPage';
import CreditsPage       from './pages/CreditsPage';

import './styles/global.css';

// Routes that need full-bleed layout (no max-width / padding container)
const FULL_BLEED_PATHS = ['/editor'];

function AppLayout() {
  const location = useLocation();
  const isFullBleed =
    location.pathname === '/' ||
    FULL_BLEED_PATHS.some((p) => location.pathname.startsWith(p));

  return (
    <div className="app">
      <Header />
      <main className={isFullBleed ? 'main-content main-content--full' : 'main-content'}>
        <Routes>
          {/* ── Public ────────────────────────────────────────────── */}
          <Route path="/"              element={<LandingPage />} />
          <Route path="/login"         element={<LoginPage />} />
          <Route path="/register"      element={<RegisterPage />} />
          <Route path="/auth/callback" element={<OAuthCallbackPage />} />

          {/* Legacy step-by-step upload flow */}
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/style"  element={<StyleSelectPage />} />
          <Route path="/mask"   element={<MaskingPage />} />
          <Route path="/result" element={<ResultPage />} />

          {/* ── Protected ─────────────────────────────────────────── */}
          <Route path="/dashboard"
            element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />

          <Route path="/editor"
            element={<ProtectedRoute><EditorPage /></ProtectedRoute>} />
          <Route path="/editor/:projectId"
            element={<ProtectedRoute><EditorPage /></ProtectedRoute>} />

          <Route path="/furniture"
            element={<ProtectedRoute><FurniturePage /></ProtectedRoute>} />
          <Route path="/furniture/:projectId"
            element={<ProtectedRoute><FurniturePage /></ProtectedRoute>} />

          <Route path="/dashboard/credits"
            element={<ProtectedRoute><CreditsPage /></ProtectedRoute>} />
        </Routes>
      </main>
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 4000,
          style: {
            background: '#111',
            color: '#fff',
            border: '1px solid #2a2a2a',
          },
        }}
      />
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <Router>
        <AppLayout />
      </Router>
    </AuthProvider>
  );
}

export default App;
