/**
 * CreditsPage — /dashboard/credits
 *
 * Shows:
 *  1. Hero section with credit balance
 *  2. Pricing plan cards (3-column grid)
 *  3. Paginated transaction history table
 */
import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import api from '../utils/api';
import './CreditsPage.css';

const PLANS = [
  {
    key:       'free',
    name:      'Free',
    subtitle:  'Explore the architecture of AI',
    price:     null,
    credits:   10,
    period:    '가입 시',
    features:  ['10 크레딧 (가입 지급)', '모든 기능 체험'],
    cta:       null,
    badge:     'Current Plan',
    badgeType: 'neutral',
    variant:   'default',
  },
  {
    key:       'basic',
    name:      'Basic',
    subtitle:  'For emerging designers',
    price:     '₩9,900',
    credits:   50,
    period:    '월',
    features:  ['High-res rendering (4K)', 'Advanced Style Transfer', 'Priority processing'],
    cta:       'Upgrade Now',
    badge:     'Most Popular',
    badgeType: 'primary',
    variant:   'primary',
  },
  {
    key:       'pro',
    name:      'Pro',
    subtitle:  "The architect's suite",
    price:     '₩29,900',
    credits:   200,
    period:    '월',
    features:  ['Unlimited Material Change', 'Commercial usage license', 'Dedicated account manager'],
    cta:       'Select Pro',
    badge:     'Best Value',
    badgeType: 'gold',
    variant:   'gold',
  },
];

const TYPE_CONFIG = {
  purchase: { label: '충전',   color: '#4ade80',  bg: 'rgba(74,222,128,0.1)' },
  usage:    { label: '사용',   color: '#ff6e84',  bg: 'rgba(255,110,132,0.1)' },
  bonus:    { label: '보너스', color: '#bd9dff',  bg: 'rgba(189,157,255,0.1)' },
  refund:   { label: '환불',   color: '#60a5fa',  bg: 'rgba(96,165,250,0.1)' },
};

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

export default function CreditsPage() {
  const { creditBalance, usedThisMonth, refreshBalance } = useAuth();

  const [history, setHistory]         = useState([]);
  const [total, setTotal]             = useState(0);
  const [page, setPage]               = useState(1);
  const [totalPages, setTotalPages]   = useState(1);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [purchasing, setPurchasing]   = useState(null);

  const fetchHistory = useCallback(async (p = 1) => {
    setLoadingHistory(true);
    try {
      const { data } = await api.get(`/v1/credits/history?page=${p}&page_size=15`);
      setHistory(data.items);
      setTotal(data.total);
      setTotalPages(data.total_pages);
      setPage(p);
    } catch (err) {
      toast.error(err.message || '내역 조회 실패');
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    refreshBalance();
    fetchHistory(1);
  }, [refreshBalance, fetchHistory]);

  async function handlePurchase(plan) {
    if (!plan.cta) return;
    setPurchasing(plan.key);
    try {
      const { data } = await api.post('/v1/credits/purchase', { plan: plan.key });
      toast.success(data.message);
      await refreshBalance();
      fetchHistory(1);
    } catch (err) {
      toast.error(err.message || '충전 실패');
    } finally {
      setPurchasing(null);
    }
  }

  return (
    <div className="cp-page">
      <div className="cp-inner">

        {/* ── Hero Section ──────────────────────────────────────────────── */}
        <header className="cp-hero">
          <span className="cp-hero-label">Account Intelligence</span>
          <h1 className="cp-hero-title">Credit Management</h1>
          <div className="cp-hero-balance">
            <span className="cp-balance-num">
              {creditBalance === null ? '…' : creditBalance}
            </span>
            <span className="cp-balance-sub">Credits available</span>
          </div>
        </header>

        {/* ── Pricing Grid ──────────────────────────────────────────────── */}
        <div className="cp-plans-grid">
          {PLANS.map((plan) => (
            <div key={plan.key} className={`cp-plan-card cp-plan-card--${plan.variant}`}>
              {/* Top color line (primary/gold only) */}
              {plan.variant !== 'default' && (
                <div className={`cp-plan-topline cp-plan-topline--${plan.variant}`} />
              )}

              {/* Badge */}
              <div className="cp-plan-badge-wrap">
                <span className={`cp-plan-badge cp-plan-badge--${plan.badgeType}`}>
                  {plan.badge}
                </span>
              </div>

              {/* Name */}
              <div className="cp-plan-meta">
                <h3 className="cp-plan-name">{plan.name}</h3>
                <p className="cp-plan-subtitle">{plan.subtitle}</p>
              </div>

              {/* Credits / Price */}
              <div className="cp-plan-pricing">
                <div className="cp-plan-credits-row">
                  <span className="cp-plan-credits-num">{plan.credits}</span>
                  <span className="cp-plan-credits-label">credits / {plan.period}</span>
                </div>
                {plan.price && (
                  <span className={`cp-plan-price cp-plan-price--${plan.variant}`}>{plan.price}</span>
                )}
              </div>

              {/* Features */}
              <ul className="cp-plan-features">
                {plan.features.map((f) => (
                  <li key={f} className="cp-plan-feature">
                    <span
                      className="material-symbols-outlined cp-plan-check"
                      style={{ fontVariationSettings: plan.variant !== 'default' ? "'FILL' 1" : undefined }}
                    >
                      check_circle
                    </span>
                    {f}
                  </li>
                ))}
              </ul>

              {/* CTA */}
              {plan.cta ? (
                <button
                  className={`cp-plan-cta cp-plan-cta--${plan.variant}`}
                  onClick={() => handlePurchase(plan)}
                  disabled={purchasing === plan.key}
                >
                  {purchasing === plan.key ? '처리 중...' : plan.cta}
                </button>
              ) : (
                <button className="cp-plan-cta cp-plan-cta--manage" disabled>
                  Manage Subscription
                </button>
              )}
            </div>
          ))}
        </div>

        {/* ── Usage History ─────────────────────────────────────────────── */}
        <section className="cp-history-section">
          <div className="cp-history-header">
            <div>
              <h2 className="cp-history-title">Usage History</h2>
              <p className="cp-history-sub">Detailed ledger of your intelligence consumption.</p>
            </div>
            <button className="cp-export-btn">
              <span className="material-symbols-outlined">download</span>
              Export CSV
            </button>
          </div>

          {loadingHistory ? (
            <div className="cp-loading">
              <span className="spinner" />
              내역 로딩 중...
            </div>
          ) : history.length === 0 ? (
            <div className="cp-empty">
              <span className="material-symbols-outlined" style={{ fontSize: '2.5rem', color: '#484849' }}>receipt_long</span>
              <p>아직 거래 내역이 없습니다.</p>
            </div>
          ) : (
            <>
              <div className="cp-table-wrap">
                <table className="cp-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Action</th>
                      <th>Feature Used</th>
                      <th className="cp-th-right">Credits</th>
                      <th className="cp-th-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((tx, idx) => {
                      const meta = TYPE_CONFIG[tx.type] ?? { label: tx.type, color: '#adaaab', bg: 'rgba(255,255,255,0.05)' };
                      return (
                        <tr key={tx.id} className={idx % 2 === 0 ? 'cp-row-even' : 'cp-row-odd'}>
                          <td className="cp-td-date">{formatDate(tx.created_at)}</td>
                          <td className="cp-td-action">{tx.description}</td>
                          <td>
                            {tx.feature_used ? (
                              <span className="cp-feature-tag" style={{ color: meta.color, background: meta.bg }}>
                                {tx.feature_used}
                              </span>
                            ) : (
                              <span className="cp-feature-tag" style={{ color: '#adaaab', background: 'rgba(255,255,255,0.05)' }}>
                                {meta.label}
                              </span>
                            )}
                          </td>
                          <td className={`cp-td-amount ${tx.amount >= 0 ? 'positive' : 'negative'}`}>
                            {tx.amount >= 0 ? `+${tx.amount}` : tx.amount}
                          </td>
                          <td className="cp-td-balance">{tx.balance_after ?? '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="cp-pagination">
                  <button
                    className="cp-page-arrow"
                    onClick={() => fetchHistory(page - 1)}
                    disabled={page <= 1}
                  >
                    <span className="material-symbols-outlined">chevron_left</span>
                  </button>
                  <div className="cp-page-nums">
                    {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => i + 1).map((p) => (
                      <button
                        key={p}
                        className={`cp-page-num ${p === page ? 'active' : ''}`}
                        onClick={() => fetchHistory(p)}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                  <button
                    className="cp-page-arrow"
                    onClick={() => fetchHistory(page + 1)}
                    disabled={page >= totalPages}
                  >
                    <span className="material-symbols-outlined">chevron_right</span>
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
