// Upgrade-to-team guidance dialog.
//
// Demo-only billing picker shown when a free-plan user tries to invite
// collaborators. Prices are represented as seat fees and token allowance.

import { useEffect, useState } from 'react';
import { Icon } from './Icon';

interface Props {
  open: boolean;
  onClose: () => void;
  initialSeatCount?: number;
  minSeatCount?: number;
  mode?: 'upgrade' | 'seats';
  /** "升级到团队版" — defaults to onClose when omitted. */
  onConfirm?: (config: { seatCount: number; tierId: string; tierName: string; tokens: number }) => void;
}

const DEFAULT_SEAT_COUNT = 3;
const TEAM_TIERS = [
  { id: 'starter', name: '小团队协作入门', tokens: 40 },
  { id: 'growth', name: '常规项目协作', tokens: 80, recommended: true },
  { id: 'scale', name: '高频生成与评审', tokens: 220 },
];
const TEAM_BENEFITS = [
  '资产共享与管理：项目 / 设计系统 / 插件',
  '协作：评论 / 变更 / 历史版本',
  '基于角色的权限管理（Owner / Manager / Editor / Viewer）',
  '团队用量面板与计费管理',
];

export function UpgradeTeamDialog({
  open,
  onClose,
  onConfirm,
  initialSeatCount = DEFAULT_SEAT_COUNT,
  minSeatCount = DEFAULT_SEAT_COUNT,
  mode = 'upgrade',
}: Props) {
  const [selectedTierId, setSelectedTierId] = useState('growth');
  const [seatCount, setSeatCount] = useState(Math.max(initialSeatCount, minSeatCount));

  useEffect(() => {
    if (!open) return;
    setSeatCount(Math.max(initialSeatCount, minSeatCount));
  }, [initialSeatCount, minSeatCount, open]);

  if (!open) return null;

  const selectedTier = TEAM_TIERS.find((tier) => tier.id === selectedTierId) ?? TEAM_TIERS[1];
  const selectedTierName = selectedTier?.name ?? '常规项目协作';
  const selectedTokens = selectedTier?.tokens ?? 80;
  const purchaseSeatsMode = mode === 'seats';
  // Total the user will actually be charged — shown on the CTA so a payment
  // action never hides its amount.
  const monthlyTotal = selectedTokens * seatCount;

  function adjustSeatCount(delta: number) {
    setSeatCount((current) => Math.max(minSeatCount, current + delta));
  }

  function handleConfirm() {
    onConfirm?.({
      seatCount,
      tierId: selectedTier?.id ?? 'growth',
      tierName: selectedTierName,
      tokens: selectedTokens,
    });
    if (!onConfirm) onClose();
  }

  return (
    <div className="entry-invite" role="dialog" aria-modal="true" aria-label={purchaseSeatsMode ? '购买席位' : '升级到团队版'}>
      <div className="entry-invite__backdrop" onClick={onClose} />
      <div className="upgrade-team">
        <button
          type="button"
          className="entry-invite__close"
          onClick={onClose}
          aria-label="关闭"
        >
          <Icon name="close" size={16} />
        </button>

        <div className="upgrade-team__head">
          <h2 className="upgrade-team__title">{purchaseSeatsMode ? '购买更多席位' : '选择团队版档位'}</h2>
          <p className="upgrade-team__subtitle">
            {purchaseSeatsMode
              ? `新增席位会按当前团队档位计费，至少购买到 ${minSeatCount} 个席位。月费随席位数同步增加。`
              : `团队版按席位计费，最少 ${minSeatCount} 个席位。不同档位对应不同的每席位月费。`}
          </p>
        </div>

        <div className="upgrade-team__seat-summary">
          <span>席位数</span>
          <span className="upgrade-team__seat-stepper" aria-label="席位数量">
            <button
              type="button"
              onClick={() => adjustSeatCount(-1)}
              disabled={seatCount <= minSeatCount}
              aria-label="减少席位"
            >
              -
            </button>
            <strong>{seatCount} 个席位</strong>
            <button type="button" onClick={() => adjustSeatCount(1)} aria-label="增加席位">
              +
            </button>
          </span>
        </div>

        <div className="upgrade-team__plans" role="radiogroup" aria-label="团队版档位">
          {TEAM_TIERS.map((tier) => {
            const isSelected = tier.id === selectedTierId;

            return (
              <button
                key={tier.id}
                type="button"
                className={`upgrade-team__plan${tier.recommended ? ' is-recommended' : ''}${isSelected ? ' is-selected' : ''}`}
                role="radio"
                aria-checked={isSelected ? 'true' : 'false'}
                onClick={() => setSelectedTierId(tier.id)}
              >
                <span className="upgrade-team__plan-top">
                  <strong>{tier.name}</strong>
                  {tier.recommended ? <small>推荐</small> : null}
                </span>
                <span className="upgrade-team__plan-token">
                  <small className="upgrade-team__plan-currency">$</small>
                  {tier.tokens}
                  <small> / 席位·月</small>
                </span>
                <span className="upgrade-team__plan-allowance-label">
                  {seatCount} 席位共含 <strong>${tier.tokens * seatCount}</strong> 等值用量额度
                </span>
              </button>
            );
          })}
        </div>

        <p className="upgrade-team__note">
          「等值用量额度」指该金额可消耗的 AI 用量，按实际 Token 计费。
        </p>

        {/* The benefits are a first-time value-prop; skip them when an
            existing team is just buying more seats — they already know. */}
        {purchaseSeatsMode ? null : (
          <ul className="upgrade-team__benefits" aria-label="团队版能力">
            {TEAM_BENEFITS.map((benefit) => (
              <li key={benefit}>
                <Icon name="check" size={13} />
                <span>{benefit}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="upgrade-team__confirm">
          <span className="upgrade-team__confirm-summary">
            {selectedTierName} · {seatCount} 席位 · 含{' '}
            <strong>${monthlyTotal}</strong> 等值用量额度
          </span>
        </div>

        <div className="upgrade-team__foot">
          <button type="button" className="entry-invite__btn" onClick={onClose}>
            {purchaseSeatsMode ? '暂不购买' : '暂不升级'}
          </button>
          <button type="button" className="entry-invite__btn is-primary" onClick={handleConfirm}>
            <Icon name="sparkles" size={14} />{' '}
            {purchaseSeatsMode
              ? `确认支付 · $${monthlyTotal}/月`
              : `确认升级 · $${monthlyTotal}/月`}
          </button>
        </div>
      </div>
    </div>
  );
}
