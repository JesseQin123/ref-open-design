// Reusable "invite teammates" dialog for the team workspace.
//
// Opened from the team dropdown in the left rail and the "全部项目" team
// header. Demo-only: all data is hard-coded Chinese mock content, no backend.
// Canva-style two-column layout — form on the left, decorative art on the right.

import { useEffect, useState } from 'react';
import { Icon } from './Icon';

export interface InviteRow {
  email: string;
  role: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Shows "你的团队有 1人" for single-seat plans (vs the team default). */
  freePlan?: boolean;
  /** Called with the entered rows when "确认并邀请" is pressed. The host
   *  decides whether to send invites directly or route through upgrade. */
  onSubmit?: (rows: InviteRow[]) => void;
  /** Owner / Manager can choose roles; Editor / Viewer invite as members. */
  canAssignRoles?: boolean;
}

const DEFAULT_ROLE = '团队成员';

export function InviteDialog({ open, onClose, freePlan = false, onSubmit, canAssignRoles = true }: Props) {
  const [rows, setRows] = useState<InviteRow[]>([{ email: '', role: DEFAULT_ROLE }]);
  const [visibilityOpen, setVisibilityOpen] = useState(false);

  useEffect(() => {
    if (!open || canAssignRoles) return;
    setRows((prev) => prev.map((row) => ({ ...row, role: DEFAULT_ROLE })));
  }, [canAssignRoles, open]);

  if (!open) return null;

  function updateRow(index: number, patch: Partial<InviteRow>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, { email: '', role: DEFAULT_ROLE }]);
  }
  function removeRow(index: number) {
    setRows((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  // Demo-grade email shape check (something@something.tld) — keeps obvious
  // non-emails from enabling submit; both the button state and the rows
  // passed to onSubmit use the same predicate.
  const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
  const hasValidEmail = rows.some((r) => isEmail(r.email));

  function handleConfirm() {
    const valid = rows.filter((r) => isEmail(r.email));
    if (valid.length === 0) return;
    onClose();
    onSubmit?.(valid);
    setRows([{ email: '', role: DEFAULT_ROLE }]);
  }

  return (
    <div className="entry-invite" role="dialog" aria-modal="true" aria-label="邀请成员">
      <div className="entry-invite__backdrop" onClick={onClose} />
      <div className="entry-invite__panel entry-invite__panel--split">
        <button
          type="button"
          className="entry-invite__close"
          onClick={onClose}
          aria-label="关闭"
        >
          <Icon name="close" size={16} />
        </button>

        <div className="entry-invite__form">
          <h2 className="entry-invite__title">邀请成员加入你的团队</h2>
          <p className="entry-invite__teamsize">
            {freePlan
              ? '免费版含 1 个席位，邀请同事后将引导你升级到团队版。'
              : '邀请同事加入团队，一起共享项目、设计系统与插件。'}
          </p>

          <div className="entry-invite__field-labels">
            <span className="entry-invite__label">通过电子邮件邀请成员</span>
            <span className="entry-invite__label entry-invite__label--role">
              {canAssignRoles ? '分配角色' : '默认身份'}
            </span>
          </div>
          <div className="entry-invite__rows">
            {rows.map((row, i) => (
              <div className="entry-invite__fields" key={i}>
                <input
                  className="entry-invite__input"
                  type="email"
                  placeholder="输入电子邮件地址……"
                  value={row.email}
                  onChange={(e) => updateRow(i, { email: e.target.value })}
                />
                <select
                  className="entry-invite__role"
                  value={canAssignRoles ? row.role : DEFAULT_ROLE}
                  onChange={(e) => updateRow(i, { role: e.target.value })}
                  disabled={!canAssignRoles}
                  aria-label={canAssignRoles ? '分配角色' : '默认身份'}
                >
                  <option value="管理员">管理员</option>
                  <option value={DEFAULT_ROLE}>团队成员</option>
                  <option value="查看者">查看者</option>
                </select>
                {rows.length > 1 ? (
                  <button
                    type="button"
                    className="entry-invite__row-remove"
                    onClick={() => removeRow(i)}
                    aria-label="移除"
                  >
                    <Icon name="close" size={15} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <button type="button" className="entry-invite__add-row" onClick={addRow}>
            <Icon name="plus" size={14} /> 添加成员
          </button>

          <button
            type="button"
            className="entry-invite__collapse"
            onClick={() => setVisibilityOpen((v) => !v)}
            aria-expanded={visibilityOpen}
          >
            团队成员会看到我的设计吗?
            <Icon
              name="chevron-down"
              size={16}
              style={visibilityOpen ? { transform: 'rotate(180deg)' } : undefined}
            />
          </button>
          {visibilityOpen ? (
            <p className="entry-invite__collapse-body">
              团队成员可以看到你共享到团队空间的设计；保存在「草稿」中的私人设计不会对其他人可见。
            </p>
          ) : null}

          <button
            type="button"
            className="entry-invite__submit"
            onClick={handleConfirm}
            disabled={!hasValidEmail}
          >
            确认并邀请
          </button>
        </div>

        <div className="entry-invite__art" aria-hidden>
          <span className="entry-invite__art-glow" />
          <div className="entry-invite__art-cluster">
            <span className="entry-invite__art-avatar">
              <img src="/team-avatars/a2.png" alt="" />
            </span>
            <span className="entry-invite__art-avatar">
              <img src="/team-avatars/a1.png" alt="" />
            </span>
            <span className="entry-invite__art-avatar">
              <img src="/team-avatars/a4.png" alt="" />
            </span>
            <span className="entry-invite__art-avatar">
              <img src="/team-avatars/a6.png" alt="" />
            </span>
            <span className="entry-invite__art-avatar entry-invite__art-avatar--invite">
              <Icon name="plus" size={26} />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
