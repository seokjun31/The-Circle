import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import api from '../utils/api';
import './AuthPage.css';

const BACKEND = process.env.REACT_APP_API_URL || '';

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [form, setForm]       = useState({ email: '', password: '' });
  const [loading, setLoading] = useState(false);

  function handleChange(e) {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.post('/v1/auth/login', form);
      await login(data.access_token);
      toast.success('로그인되었습니다.');
      navigate('/');
    } catch (err) {
      toast.error(err.message || '로그인 실패');
    } finally {
      setLoading(false);
    }
  }

  function handleOAuth(provider) {
    // Redirect browser to backend OAuth start — backend will redirect back to
    // /auth/callback?token=... after successful login.
    window.location.href = `${BACKEND}/api/v1/auth/${provider}`;
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">
          <span className="auth-logo-icon">✦</span>
          <span>The Circle</span>
        </div>
        <h1 className="auth-title">로그인</h1>
        <p className="auth-sub">AI 인테리어 렌더링 서비스에 오신 것을 환영합니다</p>

        {/* Social login */}
        <div className="social-buttons">
          <button
            type="button"
            className="social-btn google"
            onClick={() => handleOAuth('google')}
          >
            <svg className="social-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Google로 계속하기
          </button>
          <button
            type="button"
            className="social-btn kakao"
            onClick={() => handleOAuth('kakao')}
          >
            <svg className="social-icon kakao-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 3C6.477 3 2 6.477 2 10.8c0 2.733 1.713 5.133 4.313 6.507l-1.1 4.053 4.74-3.127A11.98 11.98 0 0012 18.6c5.523 0 10-3.477 10-7.8S17.523 3 12 3z" fill="#3A1D1D"/>
            </svg>
            카카오로 계속하기
          </button>
        </div>

        <div className="auth-divider"><span>또는</span></div>

        {/* Email/password form */}
        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="form-label">
            이메일
            <input
              type="email"
              name="email"
              className="form-input"
              value={form.email}
              onChange={handleChange}
              placeholder="you@example.com"
              required
              autoComplete="email"
            />
          </label>
          <label className="form-label">
            비밀번호
            <input
              type="password"
              name="password"
              className="form-input"
              value={form.password}
              onChange={handleChange}
              placeholder="••••••••"
              required
              autoComplete="current-password"
            />
          </label>
          <button type="submit" className="btn-primary auth-submit" disabled={loading}>
            {loading ? '로그인 중...' : '이메일로 로그인'}
          </button>
        </form>

        <p className="auth-switch">
          계정이 없으신가요?{' '}
          <Link to="/register" className="auth-link">회원가입</Link>
        </p>
      </div>
    </div>
  );
}
