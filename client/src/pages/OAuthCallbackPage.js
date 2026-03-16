/**
 * OAuthCallbackPage — /auth/callback
 *
 * The backend OAuth handler redirects here after a successful (or failed) social login.
 * URL format:
 *   /auth/callback?token=<jwt>       — success
 *   /auth/callback?error=<message>   — failure
 */
import React, { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import './AuthPage.css';

export default function OAuthCallbackPage() {
  const { login } = useAuth();
  const navigate  = useNavigate();
  const [params]  = useSearchParams();

  useEffect(() => {
    const token = params.get('token');
    const error = params.get('error');

    if (error) {
      toast.error(`소셜 로그인 실패: ${error}`);
      navigate('/login', { replace: true });
      return;
    }

    if (token) {
      login(token).then(() => {
        toast.success('로그인되었습니다.');
        navigate('/', { replace: true });
      });
    } else {
      navigate('/login', { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="auth-page">
      <div className="auth-card" style={{ textAlign: 'center' }}>
        <div className="auth-logo">
          <span className="auth-logo-icon">✦</span>
          <span>The Circle</span>
        </div>
        <p style={{ color: 'var(--text-muted)', marginTop: '1.5rem' }}>
          로그인 처리 중...
        </p>
        <div className="auth-spinner" />
      </div>
    </div>
  );
}
