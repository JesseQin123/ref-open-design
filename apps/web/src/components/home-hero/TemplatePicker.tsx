// Composer-footer Template picker — the "template entry point" next to the
// Design system picker. It mirrors the create-scenario rail below the composer:
// the trigger shows the currently-selected project-type template (default
// "None"), and the dropdown offers a searchable grid of the same templates so
// users understand the row below the composer *is* the template set.
//
// Selection is the existing `activeChipId`: picking a card calls `onPick(chip)`
// (the same handler the rail uses) and Clear calls `onClear()` (back to None).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { HomeHeroChip } from './chips';
import { Icon } from '../Icon';
import { useT } from '../../i18n';

interface Props {
  // Selectable templates, already ordered (the apply-scenario create chips).
  templates: HomeHeroChip[];
  activeChipId: string | null;
  disabled?: boolean;
  // Localized label / description for a chip id (reuses HomeHero's chip copy).
  labelFor: (chipId: string) => string;
  descriptionFor: (chipId: string) => string;
  onPick: (chip: HomeHeroChip) => void;
  onClear: () => void;
}

export function TemplatePicker({
  templates,
  activeChipId,
  disabled = false,
  labelFor,
  descriptionFor,
  onPick,
  onClear,
}: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const active = useMemo(
    () => templates.find((chip) => chip.id === activeChipId) ?? null,
    [templates, activeChipId],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return templates;
    return templates.filter((chip) =>
      `${labelFor(chip.id)} ${descriptionFor(chip.id)}`.toLowerCase().includes(q),
    );
  }, [query, templates, labelFor, descriptionFor]);

  useEffect(() => {
    if (open) {
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      setQuery('');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    function onPointer(event: MouseEvent) {
      if (wrapRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const valueLabel = active ? labelFor(active.id) : t('common.none');

  return (
    <div
      ref={wrapRef}
      className={`home-hero__footer-option home-hero__footer-option--select home-hero__template-option${open ? ' is-open' : ''}`}
      data-field-name="template"
      data-testid="home-hero-template-picker"
    >
      <button
        type="button"
        className="home-hero__footer-select-trigger home-hero__template-trigger"
        data-testid="home-hero-template-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={t('homeHero.templatePicker.label')}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className="home-hero__footer-option-icon home-hero__footer-option-icon--compact"
          aria-hidden
        >
          <Icon name={active ? active.icon : 'layout'} size={13} />
        </span>
        <span className="home-hero__template-kicker">{t('homeHero.templatePicker.label')}</span>
        <span className="home-hero__footer-select-label">{valueLabel}</span>
        <Icon name="chevron-down" size={12} aria-hidden />
      </button>
      {open ? (
        <div
          className="home-hero__template-menu"
          role="listbox"
          aria-label={t('homeHero.templatePicker.label')}
          data-testid="home-hero-template-menu"
        >
          <div className="home-hero__template-menu-head">
            <div className="home-hero__template-search">
              <Icon name="search" size={12} />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('homeHero.templatePicker.searchPlaceholder')}
                data-testid="home-hero-template-search"
              />
            </div>
            <button
              type="button"
              className="home-hero__template-clear"
              data-testid="home-hero-template-clear"
              onClick={() => {
                onClear();
                setQuery('');
                inputRef.current?.focus();
              }}
            >
              {t('common.clear')}
            </button>
          </div>
          <div className="home-hero__template-group-label">
            {t('homeHero.templatePicker.projectTypes')}
          </div>
          {filtered.length === 0 ? (
            <div className="home-hero__template-empty">{t('homeHero.footer.noMatches')}</div>
          ) : (
            <div className="home-hero__template-grid">
              {filtered.map((chip) => {
                const isActive = chip.id === activeChipId;
                return (
                  <button
                    key={chip.id}
                    type="button"
                    className={`home-hero__template-card${isActive ? ' is-active' : ''}`}
                    role="option"
                    aria-selected={isActive}
                    data-chip-id={chip.id}
                    data-testid={`home-hero-template-card-${chip.id}`}
                    title={descriptionFor(chip.id) || labelFor(chip.id)}
                    onClick={() => {
                      onPick(chip);
                      setOpen(false);
                    }}
                  >
                    <span className="home-hero__template-card-art" aria-hidden>
                      <Icon name={chip.icon} size={18} />
                    </span>
                    <span className="home-hero__template-card-label">{labelFor(chip.id)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
