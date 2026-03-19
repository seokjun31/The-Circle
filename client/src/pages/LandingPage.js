import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider';
import { useAuth } from '../contexts/AuthContext';

// ── Data ──────────────────────────────────────────────────────────────────────

const GALLERY = [
  {
    id: 1, label: 'Living Room', sub: 'Mid-Century Modern',
    before: 'https://images.unsplash.com/photo-1560448204-603b3fc33ddc?w=800&q=80',
    after:  'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800&q=80',
  },
  {
    id: 2, label: 'Bedroom', sub: 'Zen Minimalist',
    before: 'https://images.unsplash.com/photo-1598928506311-c55ded91a20c?w=800&q=80',
    after:  'https://images.unsplash.com/photo-1567225557594-88d73e55f2cb?w=800&q=80',
  },
  {
    id: 3, label: 'Kitchen', sub: 'Navy & Brass',
    before: 'https://images.unsplash.com/photo-1484101403633-562f891dc89a?w=800&q=80',
    after:  'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=800&q=80',
  },
];

const FEATURES = [
  { icon: 'auto_fix_high',  title: 'Circle.ai 스타일 변환',  desc: '8가지 프리셋 스타일로 방 전체 분위기를 한 번에 변환. 재팬디, 모던, 미니멀 등 원하는 스타일을 즉시 적용합니다.' },
  { icon: 'texture',        title: '자재 선택 & 적용',        desc: 'AI가 벽·바닥·천장을 자동 인식. 타일, 원목, 대리석 등 원하는 자재를 선택하면 해당 영역에 정밀하게 합성.' },
  { icon: 'photo_library',  title: '분위기 Copy',             desc: '마음에 드는 인테리어 사진을 업로드하면 그 조명·색감·분위기를 내 방에 그대로 재현. 레퍼런스 기반 스타일 이전.' },
  { icon: 'chair',          title: '가구 배치',               desc: '원하는 가구를 선택해 원하는 위치에 배치. AI가 원근감·조명·그림자를 자동 보정하여 자연스럽게 합성.' },
];

const STEPS = [
  { num: '01', title: '사진 업로드',  desc: '빈 방 사진을 업로드하세요. 스마트폰으로 찍은 사진도 OK.' },
  { num: '02', title: '분위기 선택',  desc: '스타일 프리셋을 고르거나 참조 이미지를 업로드하세요.' },
  { num: '03', title: 'AI 변환',      desc: 'AI가 자동으로 인테리어를 변환. 채팅으로 세부 수정도 가능.' },
  { num: '04', title: '고품질 출력',  desc: '4K 포토리얼리스틱 렌더링으로 최종 이미지를 완성합니다.' },
];

const PLANS = [
  {
    name: 'Free',      price: '₩0',      period: '/월', credits: '10 크레딧',
    features: ['기본 Circle.ai 스타일 3종', '해상도 1080px', '결과 이미지 1장/작업', '워터마크 포함'],
    cta: '무료로 시작', highlight: false,
  },
  {
    name: 'Pro',       price: '₩29,000', period: '/월', credits: '200 크레딧',
    features: ['모든 Circle.ai 스타일', '해상도 2K', '최종 렌더링', '워터마크 없음', '우선 처리'],
    cta: '7일 무료 체험', highlight: true,
  },
  {
    name: 'Business',  price: '₩99,000', period: '/월', credits: '1,000 크레딧',
    features: ['Pro 모든 기능', 'API 접근', '팀 계정 5명', '전담 지원', '커스텀 스타일'],
    cta: '문의하기', highlight: false,
  },
];

// ── Helper: glass card style ───────────────────────────────────────────────────
const glass = 'bg-surface-container-high/60 backdrop-blur-xl border border-white/5';

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
    <div className="bg-background text-on-surface font-body min-h-screen">

      {/* ── NAV ──────────────────────────────────────────────────────────────── */}
      <nav className="fixed top-0 w-full z-50 bg-background/80 backdrop-blur-xl border-b border-white/5 shadow-2xl shadow-black/50">
        <div className="flex justify-between items-center px-6 md:px-8 py-4 max-w-7xl mx-auto">
          <span className="text-2xl font-black tracking-tighter text-white font-headline">
            ⬤ The Circle
          </span>
          <div className="hidden md:flex items-center gap-8">
            <a href="#features"     className="text-on-surface-variant font-medium font-headline hover:text-white transition-colors duration-200">기능</a>
            <a href="#gallery"      className="text-on-surface-variant font-medium font-headline hover:text-white transition-colors duration-200">갤러리</a>
            <a href="#pricing"      className="text-on-surface-variant font-medium font-headline hover:text-white transition-colors duration-200">요금제</a>
          </div>
          <div className="flex items-center gap-4">
            {user ? (
              <Link
                to="/dashboard"
                className="bg-gradient-to-br from-primary to-primary-dim text-on-primary px-6 py-2 rounded-full font-bold hover:shadow-[0_0_20px_rgba(189,157,255,0.4)] transition-all active:scale-95"
              >
                대시보드
              </Link>
            ) : (
              <>
                <Link to="/login"    className="text-on-surface-variant font-medium hover:text-white transition-colors font-headline">로그인</Link>
                <Link to="/register" className="bg-gradient-to-br from-primary to-primary-dim text-on-primary px-6 py-2 rounded-full font-bold hover:shadow-[0_0_20px_rgba(189,157,255,0.4)] transition-all active:scale-95">
                  무료로 시작
                </Link>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* ── HERO ─────────────────────────────────────────────────────────────── */}
      <section className="relative min-h-screen flex items-center pt-20 overflow-hidden">
        {/* Background: split diagonal before/after */}
        <div className="absolute inset-0 z-0">
          {/* After image (right half) */}
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: "url('https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=1600&q=80')" }}
          />
          {/* Before image (left diagonal) */}
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{
              backgroundImage: "url('https://images.unsplash.com/photo-1560448204-603b3fc33ddc?w=1600&q=80')",
              clipPath: 'polygon(0 0, 58% 0, 42% 100%, 0% 100%)',
            }}
          />
          {/* Diagonal divider glow */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              clipPath: 'polygon(56% 0, 58% 0, 44% 100%, 42% 100%)',
              background: 'linear-gradient(to bottom, rgba(189,157,255,0.6), rgba(124,58,237,0.4))',
            }}
          />
          {/* Dark overlay */}
          <div className="absolute inset-0 bg-black/50" />
          {/* Radial purple glow */}
          <div className="absolute inset-0 bg-hero-radial" />
        </div>

        <div className="relative z-10 max-w-7xl mx-auto px-6 md:px-8 w-full">
          <div className="max-w-3xl">
            <span className="inline-block text-primary font-label tracking-[0.2em] uppercase text-xs mb-6 px-3 py-1 bg-primary/10 rounded-full border border-primary/20">
              AI-Powered Interior Studio
            </span>
            <h1 className="text-6xl md:text-8xl font-headline font-extrabold tracking-tighter text-white mb-6 leading-[0.9]">
              당신의 집을<br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary via-primary-fixed to-primary-dim">
                꿈꾸던 공간으로
              </span>
            </h1>
            <p className="text-xl text-on-surface-variant mb-10 max-w-xl leading-relaxed">
              방 사진 하나로 수십 가지 인테리어를 즉시 시뮬레이션.<br />
              Circle.ai가 벽지, 바닥재, 가구 배치까지 자동으로 처리합니다.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <button
                onClick={handleCTA}
                className="px-10 py-5 bg-gradient-to-br from-primary to-primary-dim text-on-primary rounded-full font-bold text-lg shadow-[0_0_30px_rgba(124,58,234,0.3)] hover:shadow-[0_0_45px_rgba(124,58,234,0.5)] transition-all active:scale-95"
              >
                무료로 시작하기
              </button>
              <a
                href="#gallery"
                className={`px-10 py-5 ${glass} rounded-full font-bold text-lg text-white hover:bg-white/10 transition-all flex items-center justify-center gap-2`}
              >
                <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>play_circle</span>
                예시 보기
              </a>
            </div>
            <p className="mt-6 text-sm text-on-surface-variant/60">신용카드 불필요 · 10 크레딧 무료 제공</p>
          </div>
        </div>

        {/* Corner badge */}
        <div className={`absolute bottom-20 right-8 hidden xl:flex items-center gap-4 ${glass} p-4 rounded-2xl`}>
          <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center text-primary">
            <span className="material-symbols-outlined">compare</span>
          </div>
          <div>
            <p className="text-sm font-bold text-white">Before &amp; After</p>
            <p className="text-xs text-on-surface-variant">슬라이더로 비교해보세요</p>
          </div>
        </div>
      </section>

      {/* ── FEATURES ─────────────────────────────────────────────────────────── */}
      <section className="py-32 bg-surface" id="features">
        <div className="max-w-7xl mx-auto px-6 md:px-8">
          <div className="mb-20 text-center">
            <span className="text-primary text-xs font-label tracking-[0.2em] uppercase px-3 py-1 bg-primary/10 rounded-full border border-primary/20 inline-block mb-6">
              Features
            </span>
            <h2 className="text-4xl md:text-5xl font-headline font-bold mb-6 text-white">
              모든 인테리어 도구를 하나에
            </h2>
            <p className="text-on-surface-variant max-w-2xl mx-auto">
              전문 인테리어 디자이너의 작업을 AI가 단 몇 초 만에 재현합니다
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className={`${glass} p-8 rounded-3xl hover:bg-surface-bright transition-all duration-300 group cursor-default`}
              >
                <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center text-primary mb-8 group-hover:scale-110 transition-transform duration-300">
                  <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>
                    {f.icon}
                  </span>
                </div>
                <h3 className="text-xl font-bold mb-4 text-white">{f.title}</h3>
                <p className="text-on-surface-variant text-sm leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── GALLERY ──────────────────────────────────────────────────────────── */}
      <section className="py-32 bg-surface-container-low overflow-hidden" id="gallery">
        <div className="max-w-7xl mx-auto px-6 md:px-8">
          <div className="flex flex-col md:flex-row justify-between items-end mb-16 gap-8">
            <div>
              <span className="text-primary text-xs font-label tracking-[0.2em] uppercase px-3 py-1 bg-primary/10 rounded-full border border-primary/20 inline-block mb-4">
                Before / After
              </span>
              <h2 className="text-4xl md:text-5xl font-headline font-bold text-white mb-4">실제 변환 결과</h2>
              <p className="text-on-surface-variant">같은 방, 완전히 달라진 공간</p>
            </div>
            <div className="flex gap-3">
              {GALLERY.map((g, i) => (
                <button
                  key={g.id}
                  onClick={() => setActiveGallery(i)}
                  className={`px-5 py-2 rounded-full text-sm font-bold transition-all ${
                    activeGallery === i
                      ? 'bg-primary text-on-primary shadow-[0_0_16px_rgba(189,157,255,0.35)]'
                      : 'border border-outline-variant text-on-surface-variant hover:bg-white/5'
                  }`}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>

          {/* Main compare slider */}
          <div className="rounded-3xl overflow-hidden border border-white/5 shadow-2xl">
            <ReactCompareSlider
              itemOne={<ReactCompareSliderImage src={GALLERY[activeGallery].before} alt="Before" style={{ objectFit: 'cover' }} />}
              itemTwo={<ReactCompareSliderImage src={GALLERY[activeGallery].after}  alt="After"  style={{ objectFit: 'cover' }} />}
              style={{ height: 480 }}
            />
          </div>

          {/* Thumbnail row */}
          <div className="grid grid-cols-3 gap-6 mt-8">
            {GALLERY.map((g, i) => (
              <div
                key={g.id}
                onClick={() => setActiveGallery(i)}
                className={`group relative rounded-2xl overflow-hidden aspect-video cursor-pointer border-2 transition-all ${
                  activeGallery === i ? 'border-primary shadow-[0_0_20px_rgba(189,157,255,0.25)]' : 'border-transparent'
                }`}
              >
                <img src={g.after} alt={g.label} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                <div className={`absolute inset-0 bg-black/40 group-hover:bg-black/20 transition-colors ${glass}`} />
                <div className="absolute bottom-3 left-3">
                  <p className="text-white text-sm font-bold">{g.label}</p>
                  <p className="text-on-surface-variant text-xs">{g.sub}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ─────────────────────────────────────────────────────── */}
      <section className="py-32 bg-surface" id="how-it-works">
        <div className="max-w-7xl mx-auto px-6 md:px-8">
          <div className="text-center mb-20">
            <span className="text-primary text-xs font-label tracking-[0.2em] uppercase px-3 py-1 bg-primary/10 rounded-full border border-primary/20 inline-block mb-6">
              How It Works
            </span>
            <h2 className="text-4xl md:text-5xl font-headline font-bold text-white mb-6">4단계로 완성되는 인테리어</h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-8 relative">
            {/* Connecting line */}
            <div className="hidden md:block absolute top-10 left-[12.5%] right-[12.5%] h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />

            {STEPS.map((s, i) => (
              <div key={s.num} className="flex flex-col items-center text-center gap-4">
                <div className="relative w-20 h-20 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 z-10">
                  <span className="text-2xl font-headline font-black text-primary">{s.num}</span>
                </div>
                <h3 className="text-lg font-bold text-white">{s.title}</h3>
                <p className="text-on-surface-variant text-sm leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PRICING ──────────────────────────────────────────────────────────── */}
      <section className="py-32 bg-surface-container-low" id="pricing">
        <div className="max-w-7xl mx-auto px-6 md:px-8">
          <div className="text-center mb-24">
            <span className="text-primary text-xs font-label tracking-[0.2em] uppercase px-3 py-1 bg-primary/10 rounded-full border border-primary/20 inline-block mb-6">
              Pricing
            </span>
            <h2 className="text-4xl md:text-5xl font-headline font-bold text-white mb-6">합리적인 요금제</h2>
            <p className="text-on-surface-variant">모든 요금제는 월 단위로 구독하며 언제든 해지 가능합니다</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {PLANS.map((plan) => (
              <div
                key={plan.name}
                className={`relative flex flex-col rounded-[2rem] p-10 transition-all ${
                  plan.highlight
                    ? `${glass} border-primary/20 bg-primary/5 ring-1 ring-primary/30 scale-105 shadow-[0_0_40px_rgba(189,157,255,0.15)]`
                    : `${glass} border-white/5`
                }`}
              >
                {plan.highlight && (
                  <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-primary text-on-primary px-4 py-1 rounded-full text-xs font-bold uppercase tracking-wider whitespace-nowrap">
                    가장 인기
                  </div>
                )}
                <h3 className="text-2xl font-bold text-white mb-2">{plan.name}</h3>
                <div className="flex items-baseline mb-2">
                  <span className="text-4xl font-headline font-bold text-white">{plan.price}</span>
                  <span className="text-on-surface-variant ml-2">{plan.period}</span>
                </div>
                <div className="text-primary text-sm font-bold mb-8">{plan.credits}</div>
                <ul className="space-y-4 mb-10 flex-grow">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-3 text-on-surface-variant text-sm">
                      <span className="material-symbols-outlined text-primary text-base" style={{ fontVariationSettings: "'FILL' 1" }}>
                        check_circle
                      </span>
                      {f}
                    </li>
                  ))}
                </ul>
                <button
                  onClick={handleCTA}
                  className={`w-full py-4 rounded-full font-bold transition-all active:scale-95 ${
                    plan.highlight
                      ? 'bg-primary text-on-primary hover:shadow-[0_0_20px_rgba(189,157,255,0.3)]'
                      : 'border border-outline-variant text-white hover:bg-white/5'
                  }`}
                >
                  {plan.cta}
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA BANNER ───────────────────────────────────────────────────────── */}
      <section className="py-32 relative overflow-hidden bg-primary/5">
        <div className="absolute inset-0 bg-hero-radial opacity-60" />
        <div className="max-w-7xl mx-auto px-6 md:px-8 relative z-10">
          <div className={`${glass} p-16 md:p-20 rounded-[3rem] text-center bg-gradient-to-br from-surface-container-high to-surface-container-lowest`}>
            <h2 className="text-4xl md:text-6xl font-headline font-bold text-white mb-6 tracking-tighter">
              지금 바로 시작해보세요
            </h2>
            <p className="text-xl text-on-surface-variant mb-10 max-w-xl mx-auto">
              10 크레딧 무료 · 신용카드 불필요 · 설치 없이 브라우저에서 바로
            </p>
            <button
              onClick={handleCTA}
              className="px-12 py-6 bg-primary text-on-primary rounded-full font-bold text-xl shadow-[0_20px_40px_rgba(189,157,255,0.2)] hover:scale-105 hover:shadow-[0_20px_50px_rgba(189,157,255,0.35)] transition-all active:scale-95"
            >
              무료로 시작하기 →
            </button>
          </div>
        </div>
      </section>

      {/* ── FOOTER ───────────────────────────────────────────────────────────── */}
      <footer className="bg-background border-t border-white/5 py-20">
        <div className="max-w-7xl mx-auto px-6 md:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-12 mb-16">
            <div className="col-span-2 md:col-span-1">
              <span className="text-xl font-black text-white mb-4 block font-headline">⬤ The Circle</span>
              <p className="text-sm text-on-surface-variant max-w-[200px] leading-relaxed">
                AI로 인테리어의 미래를 설계합니다.
              </p>
            </div>
            <div>
              <h4 className="text-white font-bold mb-6">제품</h4>
              <ul className="space-y-4">
                <li><a href="#features" className="text-sm text-on-surface-variant hover:text-primary transition-colors">기능 소개</a></li>
                <li><a href="#gallery"  className="text-sm text-on-surface-variant hover:text-primary transition-colors">갤러리</a></li>
                <li><a href="#pricing"  className="text-sm text-on-surface-variant hover:text-primary transition-colors">요금제</a></li>
              </ul>
            </div>
            <div>
              <h4 className="text-white font-bold mb-6">지원</h4>
              <ul className="space-y-4">
                <li><a href="#how-it-works"               className="text-sm text-on-surface-variant hover:text-primary transition-colors">사용 가이드</a></li>
                <li><a href="mailto:support@thecircle.ai" className="text-sm text-on-surface-variant hover:text-primary transition-colors">고객 지원</a></li>
              </ul>
            </div>
            <div>
              <h4 className="text-white font-bold mb-6">계정</h4>
              <ul className="space-y-4">
                <li><Link to="/login"    className="text-sm text-on-surface-variant hover:text-primary transition-colors">로그인</Link></li>
                <li><Link to="/register" className="text-sm text-on-surface-variant hover:text-primary transition-colors">회원가입</Link></li>
              </ul>
            </div>
          </div>

          <div className="pt-8 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-4">
            <span className="text-sm text-on-surface-variant">© 2026 The Circle. All rights reserved.</span>
            <div className="flex gap-6">
              <span className="material-symbols-outlined text-on-surface-variant hover:text-white cursor-pointer transition-colors">public</span>
              <span className="material-symbols-outlined text-on-surface-variant hover:text-white cursor-pointer transition-colors">share</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default LandingPage;
