/**
 * CreditsPage — /dashboard/credits
 *
 * Shows:
 *  1. Current credit balance + this month's usage
 *  2. Pricing plan cards with purchase buttons
 *  3. Paginated transaction history
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
    price:     '무료',
    credits:   10,
    period:    '가입 시',
    features:  ['10 크레딧 (가입 지급)', '모든 기능 체험'],
    cta:       null,
    highlight: false,
  },
  {
    key:       'basic',
    name:      'Basic',
    price:     '9,900원',
    credits:   50,
    period:    '월',
    features:  ['50 크레딧/월', '스타일 변환 25회', '이메일 지원'],
    cta:       'Basic 충전',
    highlight: false,
  },
  {
    key:       'pro',
    name:      'Pro',
    price:     '29,900원',
    credits:   200,
    period:    '월',
    features:  ['200 크레딧/월', '고품질 렌더링', '우선 지원', '모든 기능 무제한'],
    cta:       'Pro 충전',
    highlight: true,
  },
  {
    key:       'enterprise',
    name:      'Enterprise',
    price:     '별도 협의',
    credits:   null,
    period:    '',
    features:  ['무제한 크레딧', '전용 서버', '전담 매니저'],
    cta:       '문의하기',
    highlight: false,
  },
];

const TYPE_LABEL = {
  purchase: { label: '충전', color: 'var(--success, #a6e3a1)' },
  usage:    { label: '사용', color: 'var(--error, #f38ba8)' },
  bonus:    { label: '보너스', color: 'var(--accent)' },
  refund:   { label: '환불', color: '#89b4fa' },
};

function formatDate(iso) {
  return new Date(iso).toLocaleString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function CreditsPage() {
  const { creditBalance, usedThisMonth, refreshBalance } = useAuth();

  const [history, setHistory]     = useState([]);
  const [total, setTotal]         = useState(0);
  const [page, setPage]           = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [purchasing, setPurchasing] = useState(null);

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
      fetchHistory(1);
    } catch (err) {
      toast.error(err.message || '충전 실패');
    } finally {
      setPurchasing(null);
    }
  }

  return (
    <div className="credits-page">
      <div className="credits-inner">
        <h1 className="credits-heading">크레딧 관리</h1>

        {/* ── Balance summary ──────────────────────────────────────────── */}
        <div className="balance-cards">
          <div className="balance-card">
            <span className="balance-icon">◈</span>
            <div>
              <div className="balance-value">
                {creditBalance === null ? '…' : creditBalance}
              </div>
              <div className="balance-sub">현재 잔액</div>
            </div>
          </div>
          <div className="balance-card">
            <span className="balance-icon used">↓</span>
            <div>
              <div className="balance-value">{usedThisMonth}</div>
              <div className="balance-sub">이번 달 사용</div>
            </div>
          </div>
          <div className="balance-card">
            <span className="balance-icon tx">≡</span>
            <div>
              <div className="balance-value">{total}</div>
              <div className="balance-sub">총 거래 수</div>
            </div>
          </div>
        </div>

        {/* ── Pricing plans ────────────────────────────────────────────── */}
        <h2 className="section-heading">요금제</h2>
        <div className="credits-plans-grid">
          {PLANS.map((plan) => (
            <div
              key={plan.key}
              className={`credits-plan-card ${plan.highlight ? 'credits-plan-highlight' : ''}`}
            >
              {plan.highlight && <span className="credits-plan-badge">추천</span>}
              <div className="cplan-name">{plan.name}</div>
              <div className="cplan-price">
                {plan.price}
                {plan.period && <span className="cplan-period"> / {plan.period}</span>}
              </div>
              {plan.credits && (
                <div className="cplan-credits">◈ {plan.credits} 크레딧</div>
              )}
              <ul className="cplan-features">
                {plan.features.map((f) => (
                  <li key={f}><span className="cplan-check">✓</span>{f}</li>
                ))}
              </ul>
              {plan.cta && (
                <button
                  className={`cplan-cta ${plan.highlight ? 'cplan-cta-primary' : 'cplan-cta-secondary'}`}
                  onClick={() => handlePurchase(plan)}
                  disabled={purchasing === plan.key}
                >
                  {purchasing === plan.key ? '처리 중...' : plan.cta}
                </button>
              )}
            </div>
          ))}
        </div>

        {/* ── Transaction history ───────────────────────────────────────── */}
        <h2 className="section-heading">크레딧 사용 내역</h2>

        {loadingHistory ? (
          <div className="history-loading">내역 로딩 중...</div>
        ) : history.length === 0 ? (
          <div className="history-empty">아직 거래 내역이 없습니다.</div>
        ) : (
          <>
            <div className="history-table-wrap">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>날짜</th>
                    <th>구분</th>
                    <th>내용</th>
                    <th>기능</th>
                    <th className="amount-col">크레딧</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((tx) => {
                    const meta = TYPE_LABEL[tx.type] ?? { label: tx.type, color: 'var(--text-muted)' };
                    return (
                      <tr key={tx.id}>
                        <td className="tx-date">{formatDate(tx.created_at)}</td>
                        <td>
                          <span className="tx-type-badge" style={{ color: meta.color }}>
                            {meta.label}
                          </span>
                        </td>
                        <td className="tx-desc">{tx.description}</td>
                        <td className="tx-feature">{tx.feature_used ?? '—'}</td>
                        <td className={`tx-amount ${tx.amount >= 0 ? 'positive' : 'negative'}`}>
                          {tx.amount >= 0 ? `+${tx.amount}` : tx.amount}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="history-pagination">
                <button
                  className="page-btn"
                  onClick={() => fetchHistory(page - 1)}
                  disabled={page <= 1}
                >
                  ← 이전
                </button>
                <span className="page-info">{page} / {totalPages}</span>
                <button
                  className="page-btn"
                  onClick={() => fetchHistory(page + 1)}
                  disabled={page >= totalPages}
                >
                  다음 →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
