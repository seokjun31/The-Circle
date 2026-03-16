/**
 * InsufficientCreditModal
 *
 * Shown when an API call returns 402 Payment Required.
 * Displays a pricing table with Free / Basic / Pro / Enterprise plans
 * and allows the user to purchase credits directly (stub endpoint).
 *
 * Props:
 *   open          — boolean
 *   onClose       — () => void
 *   required      — number (credits needed)
 *   balance       — number (current balance)
 */
import React, { useState } from 'react';
import toast from 'react-hot-toast';
import api from '../utils/api';
import { useAuth } from '../contexts/AuthContext';
import './InsufficientCreditModal.css';

const PLANS = [
  {
    key:      'free',
    name:     'Free',
    price:    '무료',
    credits:  10,
    period:   '가입 시 1회',
    features: ['10 크레딧 (체험)', '모든 기능 이용 가능', '이메일 지원'],
    cta:      null,  // no purchase button for free tier
    highlight: false,
  },
  {
    key:      'basic',
    name:     'Basic',
    price:    '9,900원',
    credits:  50,
    period:   '월',
    features: ['50 크레딧/월', '스타일 변환 25회', '이메일 지원'],
    cta:      'Basic 구매',
    highlight: false,
  },
  {
    key:      'pro',
    name:     'Pro',
    price:    '29,900원',
    credits:  200,
    period:   '월',
    features: ['200 크레딧/월', '모든 기능 무제한', '우선 지원', '고품질 렌더링'],
    cta:      'Pro 구매',
    highlight: true,
  },
  {
    key:      'enterprise',
    name:     'Enterprise',
    price:    '별도 협의',
    credits:  null,
    period:   '',
    features: ['무제한 크레딧', '전용 서버', '전담 매니저', 'SLA 보장'],
    cta:      '문의하기',
    highlight: false,
  },
];

const CREDIT_COSTS = [
  { label: 'Circle.ai 스타일 변환',    cost: 2 },
  { label: '자재 적용 (영역당)',        cost: 1 },
  { label: '분위기 Copy',             cost: 3 },
  { label: '가구 배치 (AI 합성)',      cost: 1 },
  { label: '최종 렌더링 (표준)',        cost: 3 },
  { label: '최종 렌더링 (고품질)',      cost: 5 },
];

export default function InsufficientCreditModal({ open, onClose, required, balance }) {
  const { refreshBalance } = useAuth();
  const [purchasing, setPurchasing] = useState(null);

  if (!open) return null;

  async function handlePurchase(plan) {
    if (plan.key === 'enterprise') {
      toast('엔터프라이즈 문의: contact@thecircle.ai', { icon: '📩' });
      return;
    }
    if (!plan.cta) return;

    setPurchasing(plan.key);
    try {
      const { data } = await api.post('/v1/credits/purchase', { plan: plan.key });
      toast.success(data.message);
      await refreshBalance();
      onClose();
    } catch (err) {
      toast.error(err.message || '결제 처리 중 오류가 발생했습니다.');
    } finally {
      setPurchasing(null);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <div className="modal-header-icon">◈</div>
          <div>
            <h2 className="modal-title">크레딧이 부족합니다</h2>
            <p className="modal-subtitle">
              현재 잔액 <strong>{balance}</strong>크레딧 · 필요 <strong>{required}</strong>크레딧
            </p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="닫기">✕</button>
        </div>

        {/* Credit cost reference */}
        <div className="credit-cost-table">
          <h3 className="cost-table-title">기능별 크레딧 소모량</h3>
          <div className="cost-rows">
            {CREDIT_COSTS.map((item) => (
              <div key={item.label} className={`cost-row ${item.cost === required ? 'highlight' : ''}`}>
                <span className="cost-label">{item.label}</span>
                <span className="cost-badge">{item.cost}크레딧</span>
              </div>
            ))}
          </div>
        </div>

        {/* Pricing plans */}
        <h3 className="plans-heading">요금제 선택</h3>
        <div className="plans-grid">
          {PLANS.map((plan) => (
            <div
              key={plan.key}
              className={`plan-card ${plan.highlight ? 'plan-highlight' : ''}`}
            >
              {plan.highlight && <span className="plan-badge">추천</span>}
              <div className="plan-name">{plan.name}</div>
              <div className="plan-price">
                {plan.price}
                {plan.period && <span className="plan-period"> / {plan.period}</span>}
              </div>
              {plan.credits && (
                <div className="plan-credits">◈ {plan.credits} 크레딧</div>
              )}
              <ul className="plan-features">
                {plan.features.map((f) => (
                  <li key={f}><span className="feature-check">✓</span>{f}</li>
                ))}
              </ul>
              {plan.cta && (
                <button
                  className={`plan-cta ${plan.highlight ? 'plan-cta-primary' : 'plan-cta-secondary'}`}
                  onClick={() => handlePurchase(plan)}
                  disabled={purchasing === plan.key}
                >
                  {purchasing === plan.key ? '처리 중...' : plan.cta}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
