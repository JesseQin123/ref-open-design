// Team members management view (demo).
//
// UC-2 entry point 4 (team members) + role management. Demo-only:
// all data is hard-coded Chinese mock content, no backend. The
// "邀请同事" button opens the shared <InviteDialog> (self-owned open
// state), and each member's role is a controlled <select> so the
// dropdowns stay interactive for the review.

import { useState } from 'react';
import { Icon } from './Icon';
import { InviteDialog } from './InviteDialog';
import { UpgradeTeamDialog } from './UpgradeTeamDialog';
import { Confetti } from './Confetti';

type Role = '所有者' | '管理员' | '成员';

interface Member {
  id: string;
  name: string;
  email: string;
  img: string;
  role: Role;
  joinedAt: string;
  /** The current viewer ("你") — owner row, role select is disabled,
   *  and there is no "移除" action. */
  isYou?: boolean;
}

// Unified mock team (kept in sync with RecentProjectsStrip MOCK_MEMBERS).
const MOCK_MEMBERS: Member[] = [
  { id: 'qy', name: '琼羽', email: 'qiongyu@nexu.io', img: '/team-avatars/a2.png', role: '所有者', joinedAt: '2026-06-01', isYou: true },
  { id: 'zw', name: '张伟', email: 'zhangwei@nexu.io', img: '/team-avatars/a1.png', role: '管理员', joinedAt: '2026-06-24' },
  { id: 'ln', name: '李娜', email: 'lina@nexu.io', img: '/team-avatars/a3.png', role: '成员', joinedAt: '2026-06-25' },
  { id: 'wf', name: '王芳', email: 'wangfang@nexu.io', img: '/team-avatars/a4.png', role: '成员', joinedAt: '2026-06-20' },
  { id: 'cm', name: '陈明', email: 'chenming@nexu.io', img: '/team-avatars/a6.png', role: '成员', joinedAt: '2026-06-18' },
  { id: 'ly', name: '刘洋', email: 'liuyang@nexu.io', img: '/team-avatars/a7.png', role: '成员', joinedAt: '2026-06-12' },
];

const ROLE_OPTIONS: Role[] = ['所有者', '管理员', '成员'];
const MIN_TEAM_SEATS = 3;
const TEAM_PLAN_COPY = [
  '资产共享与管理：项目 / 设计系统 / 插件',
  '协作：评论 / 变更 / 历史版本',
  '基于角色的权限管理：Owner / Manager / Editor / Viewer',
  '团队用量面板与计费管理',
];

interface PendingInvite {
  email: string;
  role: string;
}

export function MembersView({ solo = false }: { solo?: boolean }) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  // Locally upgraded to team via the in-flow CTA (overrides the solo prop).
  const [upgraded, setUpgraded] = useState(false);
  const [confettiOn, setConfettiOn] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Emails showing a transient "已发送" confirmation after a resend click.
  const [resentEmails, setResentEmails] = useState<Set<string>>(() => new Set());
  // Invites entered before an upgrade was required — sent once upgraded.
  const [queuedInvites, setQueuedInvites] = useState<PendingInvite[]>([]);
  // Per-member role state so the dropdowns are interactive in the demo.
  const [roles, setRoles] = useState<Record<string, Role>>(() =>
    Object.fromEntries(MOCK_MEMBERS.map((m) => [m.id, m.role])),
  );
  const [removedMemberIds, setRemovedMemberIds] = useState<Set<string>>(() => new Set());
  const [teamSeats, setTeamSeats] = useState(MIN_TEAM_SEATS);
  const [teamTier, setTeamTier] = useState({ name: '常规项目协作', tokens: 80 });

  // A solo plan that hasn't locally upgraded behaves single-seat.
  const isSolo = solo && !upgraded;
  // Demo team state: solo shows only "you"; team shows you + one active member.
  const activeMemberIds = isSolo ? new Set(['qy']) : new Set(['qy', 'zw']);
  const members = MOCK_MEMBERS.filter((m) => activeMemberIds.has(m.id) && !removedMemberIds.has(m.id));
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const seatsUsed = members.length + pendingInvites.length;
  const seatsTotal = isSolo ? 1 : teamSeats;
  // tier.tokens is the per-seat monthly price (USD); team total = price × seats.
  const teamMonthlyTotal = teamTier.tokens * teamSeats;

  function setRole(id: string, role: Role) {
    setRoles((prev) => ({ ...prev, [id]: role }));
  }

  // "确认并邀请" from the InviteDialog. Free/solo users must upgrade first;
  // team users send invites immediately.
  function handleInviteSubmit(rows: PendingInvite[]) {
    if (rows.length === 0) return;
    if (isSolo) {
      setQueuedInvites(rows);
      setUpgradeOpen(true);
    } else {
      sendInvites(rows);
    }
  }

  function sendInvites(rows: PendingInvite[]) {
    setPendingInvites((prev) => [...prev, ...rows]);
    setToast(`已向 ${rows.length} 位同事发送邀请邮件`);
    window.setTimeout(() => setToast(null), 3200);
  }

  function resendInvite(email: string) {
    setToast(`已重新发送邀请邮件给 ${email}`);
    window.setTimeout(() => setToast(null), 3200);
    setResentEmails((prev) => new Set(prev).add(email));
    window.setTimeout(() => {
      setResentEmails((prev) => {
        const next = new Set(prev);
        next.delete(email);
        return next;
      });
    }, 2000);
  }

  function removeMember(member: Member) {
    if (member.isYou) return;
    setRemovedMemberIds((current) => {
      const next = new Set(current);
      next.add(member.id);
      return next;
    });
    setToast(`已将 ${member.name} 移出 Workspace`);
    window.setTimeout(() => setToast(null), 3200);
  }

  function adjustTeamSeats(delta: number) {
    setTeamSeats((current) => Math.max(MIN_TEAM_SEATS, current + delta));
  }

  function openSeatPurchase() {
    setUpgradeOpen(true);
  }

  // "升级到团队版" confirmed → confetti, flip to team, then auto-send the
  // queued invites so they land in the member list as pending.
  function handleUpgradeConfirm(config?: { seatCount: number; tierName: string; tokens: number }) {
    setUpgradeOpen(false);
    setUpgraded(true);
    if (config) {
      setTeamSeats(config.seatCount);
      setTeamTier({ name: config.tierName, tokens: config.tokens });
    }
    setConfettiOn(true);
    window.setTimeout(() => setConfettiOn(false), 2600);
    if (queuedInvites.length > 0) {
      sendInvites(queuedInvites);
      setQueuedInvites([]);
    } else {
      setToast(`已升级到 ${config?.tierName ?? teamTier.name}`);
      window.setTimeout(() => setToast(null), 3200);
    }
  }

  return (
    <div className="entry-section members">
      <header className="entry-section__head members__head">
        <div className="members__head-text">
          <h1 className="entry-section__title">成员</h1>
          <p className="members__subtitle">管理 Nexu 团队的成员与角色</p>
        </div>
        <button
          type="button"
          className="members__invite-btn"
          onClick={() => setInviteOpen(true)}
        >
          <Icon name="share" size={15} /> 邀请同事
        </button>
      </header>

      {toast ? <div className="members__toast">{toast}</div> : null}

      <div className="members__seats">
        <div className="members__seats-main">
          <span className="members__seats-icon" aria-hidden>
            <Icon name="info" size={14} />
          </span>
          <div className="members__seats-copy">
            <span>
              席位 <strong>{seatsUsed}/{seatsTotal}</strong> 已用 ·{' '}
              {isSolo ? '免费版仅含 1 个席位，升级团队版可邀请协作' : `${teamTier.name} · $${teamMonthlyTotal} / 团队·月`}
            </span>
            <small>{isSolo ? '团队版最少 3 个席位，按席位计费。' : '最少 3 个席位，可按团队增长继续增加。'}</small>
          </div>
          {!isSolo ? (
            <div className="members__seat-stepper" aria-label="团队席位数量">
              <button
                type="button"
                onClick={() => adjustTeamSeats(-1)}
                disabled={teamSeats <= MIN_TEAM_SEATS}
                aria-label="减少席位"
              >
                -
              </button>
              <strong>{teamSeats} 个席位</strong>
              <button type="button" onClick={openSeatPurchase} aria-label="增加席位">
                +
              </button>
            </div>
          ) : null}
        </div>
        <div className="members__seats-benefits">
          {TEAM_PLAN_COPY.map((item) => (
            <span key={item}>
              <Icon name="check" size={12} /> {item}
            </span>
          ))}
        </div>
        {!isSolo ? (
          <div className="members__auto-recharge">
            <span className="members__auto-recharge-icon" aria-hidden>
              <Icon name="refresh" size={14} />
            </span>
            <div>
              <strong>建议开启自动充值</strong>
              <p>团队额度低于阈值时自动补充，避免协作和 Agent 任务中断。</p>
            </div>
            <button type="button">开启自动充值</button>
          </div>
        ) : null}
      </div>

      <div className="members__panel">
        <div className="members__list-head" aria-hidden>
          <span className="members__col members__col--person">成员</span>
          <span className="members__col members__col--joined">加入时间</span>
          <span className="members__col members__col--role">角色</span>
          <span className="members__col members__col--action" />
        </div>

        {members.map((member) => {
          const role = roles[member.id] ?? member.role;
          return (
            <div className="members__row" key={member.id}>
              <div className="members__col members__col--person">
                <img className="members__avatar" src={member.img} alt="" aria-hidden />
                <div className="members__person-text">
                  <span className="members__name">
                    {member.name}
                    {member.isYou ? <span className="members__you-tag">你</span> : null}
                  </span>
                  <span className="members__email">{member.email}</span>
                </div>
              </div>

              <div className="members__col members__col--joined">
                <time dateTime={member.joinedAt}>{member.joinedAt}</time>
              </div>

              <div className="members__col members__col--role">
                <select
                  className="members__role-select"
                  value={role}
                  disabled={member.isYou}
                  aria-label={`${member.name} 的角色`}
                  onChange={(e) => setRole(member.id, e.target.value as Role)}
                >
                  {ROLE_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>

              <div className="members__col members__col--action">
                {member.isYou ? null : (
                  <button
                    type="button"
                    className="members__remove"
                    aria-label={`将 ${member.name} 移出 Workspace`}
                    title="移出 Workspace"
                    onClick={() => removeMember(member)}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {pendingInvites.length > 0 ? (
        <div className="members__pending">
          <h2 className="members__pending-title">待接受邀请 · {pendingInvites.length}</h2>
          <div className="members__panel">
            {pendingInvites.map((invite, i) => (
              <div className="members__row members__row--pending" key={`${invite.email}-${i}`}>
                <div className="members__col members__col--person">
                  <span className="members__avatar members__avatar--placeholder" aria-hidden>
                    <Icon name="send" size={14} />
                  </span>
                  <div className="members__person-text">
                    <span className="members__name">{invite.email}</span>
                    <span className="members__email">角色：{invite.role}</span>
                  </div>
                </div>
                <div className="members__col members__col--role">
                  <span className="members__badge">等待中</span>
                </div>
                <div className="members__col members__col--action">
                  <button
                    type="button"
                    className="members__resend"
                    onClick={() => resendInvite(invite.email)}
                    disabled={resentEmails.has(invite.email)}
                  >
                    {resentEmails.has(invite.email) ? (
                      <>
                        <Icon name="check" size={13} /> 已发送
                      </>
                    ) : (
                      <>
                        <Icon name="refresh" size={13} /> 重新发送
                      </>
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        freePlan={isSolo}
        onSubmit={handleInviteSubmit}
      />
      <UpgradeTeamDialog
        open={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        onConfirm={handleUpgradeConfirm}
        initialSeatCount={isSolo ? teamSeats : teamSeats + 1}
        minSeatCount={isSolo ? MIN_TEAM_SEATS : teamSeats + 1}
        mode={isSolo ? 'upgrade' : 'seats'}
      />
      {confettiOn ? <Confetti /> : null}
    </div>
  );
}
