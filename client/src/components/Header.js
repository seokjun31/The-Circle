import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import './Header.css';

const LEGACY_STEPS = [
  { path: '/upload', label: '사진 업로드', step: 1 },
  { path: '/style',  label: '스타일 선택', step: 2 },
  { path: '/mask',   label: '마스킹',      step: 3 },
  { path: '/result', label: '결과 확인',   step: 4 },
];

// Routes where the header itself is hidden entirely
const HIDDEN_HEADER_PATHS = ['/editor'];

// Routes where the step-nav is hidden (landing, dashboard, auth pages)
const NO_STEPNAV_PATHS = ['/', '/dashboard', '/login', '/register', '/auth'];

function Header() {
  const location = useLocation();
  const navigate  = useNavigate();
  const { user, creditBalance, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  // Hide entire header on editor route (editor has its own top bar)
  const hideHeader = HIDDEN_HEADER_PATHS.some((p) => location.pathname.startsWith(p));
  if (hideHeader) return null;

  const showStepNav = !NO_STEPNAV_PATHS.some((p) => location.pathname.startsWith(p));
  const currentStep = LEGACY_STEPS.findIndex((s) => s.path === location.pathname);

  function handleLogout() {
    logout();
    setMenuOpen(false);
    toast.success('로그아웃되었습니다.');
    navigate('/');
  }

  const isCreditsActive = location.pathname.includes('credits');
  const isDashboardActive = location.pathname.startsWith('/dashboard') && !isCreditsActive;

  return (
    <header className="header">
      <div className="header-inner">
        {/* ── Logo ───────────────────────────────────────────────────────── */}
        <Link to="/" className="logo">
          <span className="material-symbols-outlined logo-icon" style={{ fontVariationSettings: "'FILL' 1" }}>circle</span>
          <span className="logo-text">The Circle</span>
        </Link>

        {/* ── Step progress nav (legacy flow only) ──────────────────────── */}
        {showStepNav && (
          <nav className="step-nav">
            {LEGACY_STEPS.map((s, i) => (
              <React.Fragment key={s.path}>
                <div
                  className={`step-item ${i === currentStep ? 'active' : ''} ${
                    i < currentStep ? 'completed' : ''
                  }`}
                >
                  <div className="step-num">{i < currentStep ? '✓' : s.step}</div>
                  <span className="step-name">{s.label}</span>
                </div>
                {i < LEGACY_STEPS.length - 1 && (
                  <div className={`step-line ${i < currentStep ? 'completed' : ''}`} />
                )}
              </React.Fragment>
            ))}
          </nav>
        )}

        {/* ── Right side: nav links + credit badge + auth ─────────────────── */}
        <div className="header-right">
          {/* Main nav links (dashboard/credits) */}
          {user && (
            <nav className="header-nav">
              <Link
                to="/dashboard"
                className={`header-nav-link ${isDashboardActive ? 'active' : ''}`}
              >
                Projects
              </Link>
              <Link
                to="/dashboard/credits"
                className={`header-nav-link ${isCreditsActive ? 'active' : ''}`}
              >
                Credits
              </Link>
            </nav>
          )}

          {user ? (
            <>
              {/* Credit balance badge */}
              <Link to="/dashboard/credits" className="credit-badge" title="크레딧 잔액 / 충전">
                <span className="material-symbols-outlined credit-icon" style={{ fontVariationSettings: "'FILL' 1" }}>diamond</span>
                <span className="credit-value">
                  {creditBalance === null ? '…' : creditBalance}
                </span>
                <span className="credit-label">credits</span>
              </Link>

              {/* User avatar + dropdown */}
              <div className="user-menu-wrap">
                <button
                  className="user-avatar-btn"
                  onClick={() => setMenuOpen((o) => !o)}
                  aria-label="사용자 메뉴 열기"
                >
                  <span className="user-avatar-initial">
                    {user.name?.[0]?.toUpperCase() ?? '?'}
                  </span>
                </button>

                {menuOpen && (
                  <>
                    <div
                      className="dropdown-backdrop"
                      onClick={() => setMenuOpen(false)}
                    />
                    <div className="user-dropdown">
                      <div className="dropdown-user-info">
                        <span className="dropdown-name">{user.name}</span>
                        <span className="dropdown-email">{user.email}</span>
                      </div>
                      <div className="dropdown-divider" />
                      <Link
                        to="/dashboard/credits"
                        className="dropdown-item"
                        onClick={() => setMenuOpen(false)}
                      >
                        <span className="material-symbols-outlined dropdown-item-icon">diamond</span>
                        크레딧 관리
                      </Link>
                      <button
                        className="dropdown-item dropdown-logout"
                        onClick={handleLogout}
                      >
                        로그아웃
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="auth-links">
              <Link to="/login"    className="btn-ghost-sm">로그인</Link>
              <Link to="/register" className="btn-primary-sm">무료 시작</Link>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export default Header;
