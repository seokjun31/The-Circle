import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import './Header.css';

const steps = [
  { path: '/', label: '사진 업로드', step: 1 },
  { path: '/style', label: '스타일 선택', step: 2 },
  { path: '/mask', label: '마스킹', step: 3 },
  { path: '/result', label: '결과 확인', step: 4 },
];

function Header() {
  const location = useLocation();
  const currentStep = steps.findIndex(s => s.path === location.pathname);

  return (
    <header className="header">
      <div className="header-inner">
        <Link to="/" className="logo">
          <span className="logo-icon">✦</span>
          <span>AI 인테리어 렌더링</span>
        </Link>

        <nav className="step-nav">
          {steps.map((s, i) => (
            <React.Fragment key={s.path}>
              <div className={`step-item ${i === currentStep ? 'active' : ''} ${i < currentStep ? 'completed' : ''}`}>
                <div className="step-num">{i < currentStep ? '✓' : s.step}</div>
                <span className="step-name">{s.label}</span>
              </div>
              {i < steps.length - 1 && (
                <div className={`step-line ${i < currentStep ? 'completed' : ''}`} />
              )}
            </React.Fragment>
          ))}
        </nav>
      </div>
    </header>
  );
}

export default Header;
