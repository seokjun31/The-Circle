import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import './Header.css';

const steps = [
  { path: '/',       label: '사진 업로드', step: 1 },
  { path: '/style',  label: '스타일 선택', step: 2 },
  { path: '/mask',   label: '마스킹',      step: 3 },
  { path: '/result', label: '결과 확인',   step: 4 },
];

function Header() {
  const location = useLocation();
  const navigate  = useNavigate();
  const { user, creditBalance, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  const currentStep = steps.findIndex((s) => s.path === location.pathname);

  function handleLogout() {
    logout();
    setMenuOpen(false);
    toast.success('로그아웃되었습니다.');
    navigate('/');
  }

  return (
    <header className="header">
      <div className="header-inner">
        {/* ── Logo ───────────────────────────────────────────────────────── */}
        <Link to="/" className="logo">
          <span className="logo-icon">✦</span>
          <span>AI 인테리어 렌더링</span>
        </Link>

        {/* ── Step progress nav ──────────────────────────────────────────── */}
        <nav className="step-nav">
          {steps.map((s, i) => (
            <React.Fragment key={s.path}>
              <div
                className={`step-item ${i === currentStep ? 'active' : ''} ${
                  i < currentStep ? 'completed' : ''
                }`}
              >
                <div className="step-num">{i < currentStep ? '✓' : s.step}</div>
                <span className="step-name">{s.label}</span>
              </div>
              {i < steps.length - 1 && (
                <div className={`step-line ${i < currentStep ? 'completed' : ''}`} />
              )}
            </React.Fragment>
          ))}
        </nav>

        {/* ── Right side: credit badge + auth ───────────────────────────── */}
        <div className="header-right">
          {user ? (
            <>
              {/* Credit balance badge — always visible when logged in */}
              <Link to="/dashboard/credits" className="credit-badge" title="크레딧 잔액 / 충전">
                <span className="credit-icon">◈</span>
                <span className="credit-value">
                  {creditBalance === null ? '…' : creditBalance}
                </span>
                <span className="credit-label">크레딧</span>
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
                    {/* Backdrop to close on outside click */}
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
                        ◈ 크레딧 관리
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
