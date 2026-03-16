import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider';
import { useAuth } from '../contexts/AuthContext';
import './LandingPage.css';

// ── Before/After gallery data ─────────────────────────────────────────────────
const GALLERY = [
  {
    id: 1,
    label: '모던 미니멀',
    before: 'https://images.unsplash.com/photo-1560448204-603b3fc33ddc?w=600&q=80',
    after:  'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=600&q=80',
  },
  {
    id: 2,
    label: '북유럽 스칸디',
    before: 'https://images.unsplash.com/photo-1598928506311-c55ded91a20c?w=600&q=80',
    after:  'https://images.unsplash.com/photo-1567225557594-88d73e55f2cb?w=600&q=80',
  },
  {
    id: 3,
    label: '인더스트리얼',
    before: 'https://images.unsplash.com/photo-1484101403633-562f891dc89a?w=600&q=80',
    after:  'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=600&q=80',
  },
];

// ── Features ──────────────────────────────────────────────────────────────────
const FEATURES = [
  {
    icon: '🎨',
    title: 'Circle.ai',
    desc: '8가지 프리셋 스타일로 방 전체 분위기를 한 번에 변환. 클릭 한 번으로 모던, 빈티지, 미니멀 등 원하는 스타일을 즉시 적용.',
  },
  {
    icon: '🧱',
    title: '자재 선택',
    desc: 'AI가 벽·바닥·천장을 자동 인식. 원하는 자재(타일, 원목, 콘크리트 등)를 선택하면 해당 영역에 정밀하게 합성.',
  },
  {
    icon: '🖼️',
    title: '분위기 Copy',
    desc: '마음에 드는 인테리어 사진을 업로드하면 그 조명·색감·분위기를 내 방에 그대로 재현. 레퍼런스 기반 스타일 이전.',
  },
  {
    icon: '🪑',
    title: '가구 배치',
    desc: '원하는 가구를 선택해 원하는 위치에 드래그. AI가 원근감·조명·그림자를 자동 보정하여 자연스럽게 합성.',
  },
];

// ── How it works ──────────────────────────────────────────────────────────────
const STEPS = [
  { num: '01', title: '사진 촬영', desc: '빈 방 사진을 찍어 업로드하세요. 스마트폰으로 찍은 사진도 OK.' },
  { num: '02', title: '영역 선택', desc: 'AI가 자동으로 벽·바닥·천장을 인식. 원하는 영역을 클릭으로 선택.' },
  { num: '03', title: '스타일 선택', desc: '자재, Circle.ai 스타일, 분위기 Copy 중 원하는 방식을 선택.' },
  { num: '04', title: '결과 확인', desc: '수 초 내에 고품질 결과 이미지 생성. 다운로드하거나 공유하세요.' },
];

// ── Pricing ───────────────────────────────────────────────────────────────────
const PLANS = [
  {
    name: 'Free',
    price: '₩0',
    period: '/월',
    credits: '10 크레딧',
    features: ['기본 Circle.ai 스타일 3종', '해상도 1080px', '결과 이미지 1장/작업', '워터마크 포함'],
    cta: '무료로 시작',
    highlight: false,
  },
  {
    name: 'Pro',
    price: '₩29,000',
    period: '/월',
    credits: '200 크레딧',
    features: ['모든 Circle.ai 스타일', '해상도 2K', '최종 렌더링', '워터마크 없음', '우선 처리'],
    cta: '7일 무료 체험',
    highlight: true,
  },
  {
    name: 'Business',
    price: '₩99,000',
    period: '/월',
    credits: '1,000 크레딧',
    features: ['Pro 모든 기능', 'API 접근', '팀 계정 5명', '전담 지원', '커스텀 스타일'],
    cta: '문의하기',
    highlight: false,
  },
];

// ─────────────────────────────────────────────────────────────────────────────

function LandingPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [activeGallery, setActiveGallery] = useState(0);

  const handleCTA = () => {
    if (user) navigate('/dashboard');
    else navigate('/register');
  };

  return (
    <div className="landing">

      {/* ── NAV ────────────────────────────────────────────────────────────── */}
      <nav className="lp-nav">
        <div className="lp-nav-inner">
          <span className="lp-logo">⬤ The Circle</span>
          <div className="lp-nav-links">
            <a href="#features">기능</a>
            <a href="#how-it-works">사용법</a>
            <a href="#pricing">요금제</a>
          </div>
          <div className="lp-nav-actions">
            {user ? (
              <Link to="/dashboard" className="lp-btn-primary">대시보드</Link>
            ) : (
              <>
                <Link to="/login" className="lp-btn-ghost">로그인</Link>
                <Link to="/register" className="lp-btn-primary">무료로 시작</Link>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* ── HERO ───────────────────────────────────────────────────────────── */}
      <section className="lp-hero">
        <div className="lp-hero-inner">
          <div className="lp-hero-badge">AI 인테리어 스튜디오</div>
          <h1 className="lp-hero-title">
            당신의 집을<br />
            <span className="lp-hero-accent">꿈꾸던 공간으로</span>
          </h1>
          <p className="lp-hero-sub">
            방 사진 하나로 수십 가지 인테리어를 즉시 시뮬레이션.<br />
            Circle.ai가 벽지, 바닥재, 가구 배치까지 자동으로 처리합니다.
          </p>
          <div className="lp-hero-actions">
            <button className="lp-btn-primary lp-btn-lg" onClick={handleCTA}>
              무료로 시작하기 →
            </button>
            <a href="#gallery" className="lp-btn-ghost lp-btn-lg">예시 보기</a>
          </div>
          <p className="lp-hero-hint">신용카드 불필요 · 10 크레딧 무료 제공</p>
        </div>
        <div className="lp-hero-visual">
          <div className="lp-hero-badge-float lp-badge-tl">✨ AI 자동 분석</div>
          <div className="lp-hero-badge-float lp-badge-tr">🎨 8가지 스타일</div>
          <div className="lp-hero-badge-float lp-badge-bl">⚡ 10초 이내 결과</div>
          <div className="lp-hero-canvas">
            <div className="lp-hero-room">
              <div className="lp-room-before">BEFORE</div>
              <div className="lp-room-divider" />
              <div className="lp-room-after">AFTER</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── GALLERY ────────────────────────────────────────────────────────── */}
      <section className="lp-gallery" id="gallery">
        <div className="lp-section-inner">
          <div className="lp-section-label">BEFORE / AFTER</div>
          <h2 className="lp-section-title">실제 변환 결과</h2>
          <p className="lp-section-sub">같은 방, 완전히 달라진 공간</p>

          <div className="lp-gallery-tabs">
            {GALLERY.map((g, i) => (
              <button
                key={g.id}
                className={`lp-gallery-tab ${activeGallery === i ? 'active' : ''}`}
                onClick={() => setActiveGallery(i)}
              >
                {g.label}
              </button>
            ))}
          </div>

          <div className="lp-gallery-slider">
            <ReactCompareSlider
              itemOne={
                <ReactCompareSliderImage
                  src={GALLERY[activeGallery].before}
                  alt="Before"
                  style={{ objectFit: 'cover' }}
                />
              }
              itemTwo={
                <ReactCompareSliderImage
                  src={GALLERY[activeGallery].after}
                  alt="After"
                  style={{ objectFit: 'cover' }}
                />
              }
              style={{ borderRadius: 16, height: 420 }}
            />
            <div className="lp-slider-labels">
              <span>BEFORE</span>
              <span>AFTER</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── FEATURES ───────────────────────────────────────────────────────── */}
      <section className="lp-features" id="features">
        <div className="lp-section-inner">
          <div className="lp-section-label">FEATURES</div>
          <h2 className="lp-section-title">모든 인테리어 도구를 하나에</h2>
          <p className="lp-section-sub">전문 인테리어 디자이너의 작업을 AI가 단 몇 초 만에 재현합니다</p>
          <div className="lp-features-grid">
            {FEATURES.map((f) => (
              <div key={f.title} className="lp-feature-card">
                <div className="lp-feature-icon">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ───────────────────────────────────────────────────── */}
      <section className="lp-how" id="how-it-works">
        <div className="lp-section-inner">
          <div className="lp-section-label">HOW IT WORKS</div>
          <h2 className="lp-section-title">4단계로 완성되는 인테리어</h2>
          <div className="lp-steps">
            {STEPS.map((s, i) => (
              <div key={s.num} className="lp-step">
                <div className="lp-step-num">{s.num}</div>
                {i < STEPS.length - 1 && <div className="lp-step-arrow">→</div>}
                <h3>{s.title}</h3>
                <p>{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PRICING ────────────────────────────────────────────────────────── */}
      <section className="lp-pricing" id="pricing">
        <div className="lp-section-inner">
          <div className="lp-section-label">PRICING</div>
          <h2 className="lp-section-title">합리적인 요금제</h2>
          <p className="lp-section-sub">모든 요금제는 월 단위로 구독하며 언제든 해지 가능합니다</p>
          <div className="lp-plans">
            {PLANS.map((plan) => (
              <div key={plan.name} className={`lp-plan ${plan.highlight ? 'highlight' : ''}`}>
                {plan.highlight && <div className="lp-plan-badge">가장 인기</div>}
                <div className="lp-plan-name">{plan.name}</div>
                <div className="lp-plan-price">
                  {plan.price}<span>{plan.period}</span>
                </div>
                <div className="lp-plan-credits">{plan.credits}</div>
                <ul className="lp-plan-features">
                  {plan.features.map((f) => (
                    <li key={f}><span>✓</span>{f}</li>
                  ))}
                </ul>
                <button
                  className={`lp-plan-cta ${plan.highlight ? 'lp-btn-primary' : 'lp-btn-ghost'}`}
                  onClick={handleCTA}
                >
                  {plan.cta}
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA BANNER ─────────────────────────────────────────────────────── */}
      <section className="lp-cta-banner">
        <div className="lp-section-inner lp-cta-inner">
          <h2>지금 바로 시작해보세요</h2>
          <p>10 크레딧 무료 · 신용카드 불필요 · 설치 없이 브라우저에서 바로</p>
          <button className="lp-btn-primary lp-btn-lg" onClick={handleCTA}>
            무료로 시작하기 →
          </button>
        </div>
      </section>

      {/* ── FOOTER ─────────────────────────────────────────────────────────── */}
      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <div className="lp-footer-brand">
            <span className="lp-logo">⬤ The Circle</span>
            <p>AI 인테리어 스튜디오</p>
          </div>
          <div className="lp-footer-links">
            <div>
              <h4>제품</h4>
              <a href="#features">기능 소개</a>
              <a href="#pricing">요금제</a>
            </div>
            <div>
              <h4>지원</h4>
              <a href="#how-it-works">사용 가이드</a>
              <a href="mailto:support@thecircle.ai">고객 지원</a>
            </div>
            <div>
              <h4>계정</h4>
              <Link to="/login">로그인</Link>
              <Link to="/register">회원가입</Link>
            </div>
          </div>
        </div>
        <div className="lp-footer-bottom">
          <span>© 2026 The Circle. All rights reserved.</span>
        </div>
      </footer>
    </div>
  );
}

export default LandingPage;
