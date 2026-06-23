// DesignKitView — the shared brand.html-style kit layout.
//
// Renders a normalized DesignKit (see runtime/design-kit.ts) as the full module
// stack — cover, identity, logo, typography, palette, voice, imagery & layout,
// images, design-system kit, and assets — exactly matching the rendered
// brand.html. Every design-system surface (Brands tab, Design Systems list
// preview, in-project Design System tab) feeds this one component so they look
// identical regardless of whether the data came from brand.json or a parsed
// DESIGN.md.
//
// DESIGN.md is the one editable module: pass an `editor` and the view exposes a
// Visualize / Edit / Source toggle. Empty modules expose an upload affordance
// when `kit.canUpload` and an `onUploadModule` handler are provided.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Textarea } from '@open-design/components';
import { useT } from '../i18n';
import { projectRawUrl } from '../providers/registry';
import { buildSrcdoc } from '../runtime/srcdoc';
import {
  fontStack,
  isLightHex,
  type DesignKit,
  type KitFont,
} from '../runtime/design-kit';
import type { KitUploadModule } from '../runtime/kit-upload';
import { DesignSpecView } from './DesignSpecView';
import styles from './BrandPreviewCard.module.css';

const IMAGE_CAP = 8;

// ── Logo with fallback chain ────────────────────────────────────────
// Brand stage (`/api/brands/:id/logo`) when a brandId is known, else an explicit
// logoSrc, then Google's favicon for the domain, then a monogram letter.
type LogoStage = 'brand' | 'custom' | 'favicon' | 'letter';

interface KitLogoProps {
  /** Legacy alias for `brandId` (Brands list rows pass `id`). */
  id?: string;
  brandId?: string;
  logoSrc?: string | null;
  host?: string;
  name: string;
  faviconSize: number;
  className?: string;
  fallbackClassName?: string;
}

export function BrandLogo({
  id,
  brandId,
  logoSrc,
  host,
  name,
  faviconSize,
  className,
  fallbackClassName,
}: KitLogoProps) {
  const bid = brandId ?? id;
  const first: LogoStage = bid ? 'brand' : logoSrc ? 'custom' : host ? 'favicon' : 'letter';
  const [stage, setStage] = useState<LogoStage>(first);
  useEffect(() => {
    setStage(first);
  }, [first, bid, logoSrc, host]);

  const src =
    stage === 'brand' && bid
      ? `/api/brands/${encodeURIComponent(bid)}/logo`
      : stage === 'custom' && logoSrc
        ? logoSrc
        : stage === 'favicon' && host
          ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${faviconSize}`
          : null;

  if (!src) {
    return (
      <span className={fallbackClassName} aria-hidden>
        {name.slice(0, 1).toUpperCase()}
      </span>
    );
  }

  return (
    <img
      className={className}
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() =>
        setStage((s) =>
          s === 'brand' ? (logoSrc ? 'custom' : host ? 'favicon' : 'letter') : s === 'custom' ? 'favicon' : 'letter',
        )
      }
    />
  );
}

interface BrandFontManifestFile {
  family: string;
  weight: string;
  style: string;
  file: string;
  format: string;
}

// Load real typefaces so specimens render for real: append any Google Fonts
// stylesheets the kit declares, and inject self-hosted @font-face from the
// project's fonts/manifest.json. Both are best-effort and torn down on change.
export function useBrandFonts(
  projectId: string | undefined,
  fonts: { googleFontsUrl?: string }[],
): void {
  const googleUrls = useMemo(() => {
    const urls = fonts
      .map((f) => f.googleFontsUrl)
      .filter((u): u is string => Boolean(u && /^https:\/\/fonts\.googleapis\.com\//i.test(u)));
    return Array.from(new Set(urls));
  }, [fonts]);

  useEffect(() => {
    const links = googleUrls.map((href) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      document.head.appendChild(link);
      return link;
    });
    return () => {
      for (const link of links) link.remove();
    };
  }, [googleUrls]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    let styleEl: HTMLStyleElement | null = null;
    void (async () => {
      try {
        const resp = await fetch(projectRawUrl(projectId, 'fonts/manifest.json'), {
          cache: 'no-store',
        });
        if (!resp.ok) return;
        const data = (await resp.json()) as { files?: BrandFontManifestFile[] };
        const files = Array.isArray(data?.files) ? data.files : [];
        if (cancelled || files.length === 0) return;
        const css = files
          .map((f) => {
            const url = projectRawUrl(projectId, `fonts/${f.file}`);
            return [
              '@font-face {',
              `  font-family: '${f.family.replace(/'/g, '')}';`,
              `  src: url('${url}') format('${f.format}');`,
              `  font-weight: ${f.weight};`,
              `  font-style: ${f.style};`,
              '  font-display: swap;',
              '}',
            ].join('\n');
          })
          .join('\n');
        styleEl = document.createElement('style');
        styleEl.dataset.brandFonts = projectId;
        styleEl.textContent = css;
        document.head.appendChild(styleEl);
      } catch {
        // A missing/malformed manifest is expected for some systems.
      }
    })();
    return () => {
      cancelled = true;
      if (styleEl) styleEl.remove();
    };
  }, [projectId]);
}

interface BrandTokenSubset {
  colorPrimary?: string;
  colorPrimaryBg?: string;
  colorPrimaryHover?: string;
  colorPrimaryActive?: string;
  fontSize?: number;
  borderRadius?: number;
}

export interface KitEditor {
  body: string;
  onChange: (value: string) => void;
  onSave: () => void | Promise<void>;
  saving: boolean;
  canEdit: boolean;
}

export interface DesignKitViewProps {
  kit: DesignKit;
  variant?: 'panel' | 'compact';
  /** Rendered next to the title (status badges). */
  badgeSlot?: ReactNode;
  /** Rendered on the header's right (action buttons). */
  actionsSlot?: ReactNode;
  /** Rendered directly under the header (notices / errors). */
  noticeSlot?: ReactNode;
  /** Rendered above the modules (e.g. publish / default card). */
  topSlot?: ReactNode;
  /** When provided, exposes a Visualize / Edit / Source toggle for DESIGN.md. */
  editor?: KitEditor;
  onUploadModule?: (module: KitUploadModule, file: File) => void;
  uploading?: KitUploadModule | null;
  dataTestId?: string;
}

type KitMode = 'visualize' | 'edit' | 'source';

export function DesignKitView({
  kit,
  variant = 'panel',
  badgeSlot,
  actionsSlot,
  noticeSlot,
  topSlot,
  editor,
  onUploadModule,
  uploading,
  dataTestId = 'design-kit-view',
}: DesignKitViewProps) {
  const t = useT();
  const compact = variant === 'compact';
  const [mode, setMode] = useState<KitMode>('visualize');
  const [tokens, setTokens] = useState<BrandTokenSubset | null>(null);
  const [dsTheme, setDsTheme] = useState<'light' | 'dark'>('light');
  const [activeLogo, setActiveLogo] = useState(0);
  const [imagesExpanded, setImagesExpanded] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; caption: string } | null>(null);
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  useBrandFonts(kit.projectId, kit.fonts);

  const logoCandidates = useMemo(
    () => [kit.logoSrc, ...kit.logoAlternates].filter((c): c is string => Boolean(c)),
    [kit.logoSrc, kit.logoAlternates],
  );
  const activeLogoSrc = logoCandidates[activeLogo] ?? logoCandidates[0] ?? null;

  useEffect(() => {
    setActiveLogo(0);
    setImagesExpanded(false);
    setLightbox(null);
  }, [kit.designSystemId, kit.brandId]);

  // Engine token chips, when the system dir exists.
  useEffect(() => {
    const url = kit.system?.tokensUrl;
    if (!url) {
      setTokens(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) return;
        const raw = (await resp.json()) as Record<string, unknown>;
        if (cancelled) return;
        const next: BrandTokenSubset = {};
        if (typeof raw.colorPrimary === 'string') next.colorPrimary = raw.colorPrimary;
        if (typeof raw.colorPrimaryBg === 'string') next.colorPrimaryBg = raw.colorPrimaryBg;
        if (typeof raw.colorPrimaryHover === 'string') next.colorPrimaryHover = raw.colorPrimaryHover;
        if (typeof raw.colorPrimaryActive === 'string') next.colorPrimaryActive = raw.colorPrimaryActive;
        if (typeof raw.fontSize === 'number') next.fontSize = raw.fontSize;
        if (typeof raw.borderRadius === 'number') next.borderRadius = raw.borderRadius;
        setTokens(next.colorPrimary ? next : null);
      } catch {
        // Token chips are decorative.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kit.system?.tokensUrl]);

  const colors = kit.colors;
  const fonts = useMemo<{ font: KitFont; label: string }[]>(() => {
    const out: { font: KitFont; label: string }[] = [];
    if (kit.typography.display) out.push({ font: kit.typography.display, label: 'Display' });
    if (kit.typography.body) out.push({ font: kit.typography.body, label: 'Body' });
    if (kit.typography.mono) out.push({ font: kit.typography.mono, label: 'Mono' });
    return out;
  }, [kit.typography]);

  const voice = kit.voice;
  const imagery = kit.imagery;
  const layout = kit.layout;
  const samples = imagery?.samples ?? [];
  const dsKitUrl = dsTheme === 'dark' ? kit.system?.kitDarkUrl ?? kit.system?.kitUrl : kit.system?.kitUrl;
  const canUpload = Boolean(kit.canUpload && onUploadModule);

  function handleFile(module: KitUploadModule, event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file && onUploadModule) onUploadModule(module, file);
  }

  function emptyModule(hint: string, module?: KitUploadModule) {
    return (
      <div className={styles.emptyModule}>
        <span className={styles.emptyModuleText}>{hint}</span>
        {module && canUpload ? (
          <button
            type="button"
            className={styles.uploadBtn}
            disabled={uploading === module}
            onClick={() => (module === 'logo' ? logoInputRef : imageInputRef).current?.click()}
          >
            {uploading === module
              ? t('ds.uploading')
              : module === 'logo'
                ? t('ds.uploadLogo')
                : t('ds.uploadImage')}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={`${styles.previewInner} ${compact ? styles.compact : ''}`}
      data-testid={dataTestId}
      data-variant={variant}
    >
      <input
        ref={logoInputRef}
        type="file"
        accept="image/*,.svg"
        hidden
        onChange={(e) => handleFile('logo', e)}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => handleFile('image', e)}
      />

      <div className={styles.cover}>
        {kit.showcaseHtml ? (
          <span className={styles.coverFrameViewport} aria-hidden>
            <iframe
              className={styles.coverFrame}
              title={`${kit.name} preview`}
              sandbox="allow-scripts"
              srcDoc={buildSrcdoc(kit.showcaseHtml)}
              tabIndex={-1}
            />
          </span>
        ) : (
          <BrandLogo
            brandId={kit.brandId}
            logoSrc={kit.logoSrc}
            host={kit.host}
            name={kit.name}
            faviconSize={128}
            className={styles.coverLogo}
            fallbackClassName={styles.coverLogoFallback}
          />
        )}
      </div>

      <header className={styles.previewHead}>
        <div className={styles.previewHeadText}>
          <div className={styles.previewTitleRow}>
            <h2 className={styles.previewName}>{kit.name}</h2>
            {badgeSlot}
          </div>
          {kit.tagline ? <p className={styles.previewTagline}>{kit.tagline}</p> : null}
          {kit.host && kit.sourceUrl ? (
            <a
              className={styles.previewDomain}
              href={kit.sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              {kit.host}
              <ExternalGlyph />
            </a>
          ) : null}
        </div>
        {actionsSlot ? <div className={styles.previewActions}>{actionsSlot}</div> : null}
      </header>

      {noticeSlot}
      {topSlot}

      {editor && editor.canEdit ? (
        <div className={styles.modeToggle} role="tablist" aria-label={t('ds.kitVisualize')}>
          {(['visualize', 'edit', 'source'] as KitMode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={`${styles.modeToggleBtn} ${mode === m ? styles.modeToggleBtnActive : ''}`}
              onClick={() => setMode(m)}
            >
              {m === 'visualize' ? t('ds.kitVisualize') : m === 'edit' ? t('ds.kitEdit') : t('ds.kitSource')}
            </button>
          ))}
        </div>
      ) : null}

      {editor && mode === 'edit' ? (
        <div className={styles.editor}>
          <Textarea
            className={styles.editorTextarea}
            value={editor.body}
            onChange={(e) => editor.onChange(e.target.value)}
            rows={20}
            spellCheck={false}
            aria-label="DESIGN.md"
          />
          <div className={styles.editorBar}>
            <span className={styles.editorHint}>DESIGN.md</span>
            <Button variant="primary" disabled={editor.saving} onClick={() => void editor.onSave()}>
              {editor.saving ? t('ds.saving') : t('ds.saveDesignMd')}
            </Button>
          </div>
        </div>
      ) : editor && mode === 'source' ? (
        <div className={styles.sourceWrap}>
          <DesignSpecView source={editor.body} loading={false} loadingLabel="" />
        </div>
      ) : (
        <>
          {kit.description ? (
            <section className={styles.section} aria-label={t('brandDetail.identity')}>
              <h3 className={styles.sectionTitle}>{t('brandDetail.identity')}</h3>
              <p className={styles.description}>{kit.description}</p>
            </section>
          ) : null}

          {!compact ? (
            <section className={styles.section} aria-label={t('brandDetail.logo')}>
              <h3 className={styles.sectionTitle}>{t('brandDetail.logo')}</h3>
              {activeLogoSrc ? (
                <>
                  <div className={styles.logoStage}>
                    <img className={styles.logoStageImg} src={activeLogoSrc} alt={kit.name} />
                  </div>
                  {logoCandidates.length > 1 ? (
                    <div className={styles.logoThumbs}>
                      {logoCandidates.map((cand, i) => (
                        <button
                          key={cand}
                          type="button"
                          className={`${styles.logoThumb} ${i === activeLogo ? styles.logoThumbActive : ''}`}
                          onClick={() => setActiveLogo(i)}
                          aria-pressed={i === activeLogo}
                        >
                          <img src={cand} alt="" />
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {kit.logoNotes ? <p className={styles.logoNotes}>{kit.logoNotes}</p> : null}
                </>
              ) : (
                emptyModule(t('ds.moduleEmptyLogo'), 'logo')
              )}
            </section>
          ) : null}

          {fonts.length > 0 ? (
            <section className={styles.section} aria-label={t('brandDetail.typography')}>
              <h3 className={styles.sectionTitle}>{t('brandDetail.typography')}</h3>
              <div className={styles.fontTiles}>
                {fonts.map(({ font, label }) => (
                  <div key={`tile-${label}-${font.family}`} className={styles.fontTile}>
                    <div className={styles.fontTileAg} style={{ fontFamily: fontStack(font) }}>
                      Ag
                    </div>
                    <div className={styles.fontTileMeta}>
                      <span className={styles.fontTileName}>{font.family}</span>
                      <span className={styles.fontTileRole}>{label}</span>
                    </div>
                  </div>
                ))}
              </div>
              {compact ? null : (
                <div className={styles.fontList}>
                  {fonts.map(({ font, label }) => (
                    <div key={`row-${label}-${font.family}`} className={styles.fontItem}>
                      <div className={styles.fontItemHead}>
                        <span className={styles.fontRole}>{label}</span>
                        <span className={styles.fontFamily}>
                          {font.family}
                          {font.weights.length > 0 ? (
                            <span className={styles.fontWeights}> · {font.weights.join('/')}</span>
                          ) : null}
                        </span>
                      </div>
                      <span className={styles.fontSpecimen} style={{ fontFamily: fontStack(font) }}>
                        {label === 'Mono' ? 'const brand = await extract(url);' : kit.name}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ) : null}

          {colors.length > 0 ? (
            <section className={styles.section} aria-label={t('brandDetail.palette')}>
              <h3 className={styles.sectionTitle}>{t('brandDetail.palette')}</h3>
              <div className={styles.paletteGrid}>
                {colors.map((c, i) => (
                  <div key={`${c.role}-${c.hex}-${i}`} className={styles.swatch}>
                    <span className={styles.swatchChip} style={{ background: c.hex }}>
                      <span
                        className={styles.swatchHex}
                        style={{ color: isLightHex(c.hex) ? 'rgba(0,0,0,.65)' : 'rgba(255,255,255,.9)' }}
                      >
                        {c.hex}
                      </span>
                    </span>
                    <div className={styles.swatchBody}>
                      <span className={styles.swatchName}>{c.name || c.role}</span>
                      {c.role ? <span className={styles.swatchRole}>{c.role}</span> : null}
                      {!compact && c.usage ? <span className={styles.swatchUsage}>{c.usage}</span> : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {!compact && voice ? (
            <section className={styles.section} aria-label={t('brandDetail.voiceTone')}>
              <h3 className={styles.sectionTitle}>{t('brandDetail.voiceTone')}</h3>
              {voice.adjectives.length > 0 ? (
                <div className={styles.pills}>
                  {voice.adjectives.map((adj, i) => (
                    <span key={`${adj}-${i}`} className={styles.pill}>
                      {adj}
                    </span>
                  ))}
                </div>
              ) : null}
              {voice.tone ? <p className={styles.aesthetic}>{voice.tone}</p> : null}
              {voice.messagingPillars.length > 0 ? (
                <ul className={styles.pillars}>
                  {voice.messagingPillars.map((p, i) => (
                    <li key={`pillar-${i}`}>{p}</li>
                  ))}
                </ul>
              ) : null}
              {voice.vocabulary.use.length > 0 || voice.vocabulary.avoid.length > 0 ? (
                <div className={styles.vocab}>
                  {voice.vocabulary.use.length > 0 ? (
                    <div className={styles.vocabCol}>
                      <span className={styles.vocabUse}>{t('brandDetail.useLabel')}</span>
                      <span className={styles.vocabVals}>{voice.vocabulary.use.join(' · ')}</span>
                    </div>
                  ) : null}
                  {voice.vocabulary.avoid.length > 0 ? (
                    <div className={styles.vocabCol}>
                      <span className={styles.vocabAvoid}>{t('brandDetail.avoidLabel')}</span>
                      <span className={styles.vocabVals}>{voice.vocabulary.avoid.join(' · ')}</span>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {!compact && (imagery || layout) ? (
            <section className={styles.section} aria-label={t('brandDetail.imageryLayout')}>
              <h3 className={styles.sectionTitle}>{t('brandDetail.imageryLayout')}</h3>
              {imagery?.style ? <p className={styles.description}>{imagery.style}</p> : null}
              {(imagery?.subjects.length ?? 0) > 0 ? (
                <p className={styles.imageryLine}>
                  <span className={styles.imageryKey}>{t('brandDetail.subjects')}:</span>{' '}
                  {imagery?.subjects.join(', ')}
                </p>
              ) : null}
              {imagery?.treatment ? (
                <p className={styles.imageryLine}>
                  <span className={styles.imageryKey}>{t('brandDetail.treatment')}:</span>{' '}
                  {imagery.treatment}
                </p>
              ) : null}
              {(imagery?.avoid.length ?? 0) > 0 ? (
                <p className={styles.imageryLine}>
                  <span className={styles.imageryKeyAvoid}>{t('brandDetail.avoidLabel')}:</span>{' '}
                  {imagery?.avoid.join(', ')}
                </p>
              ) : null}
              {(layout?.postureRules.length ?? 0) > 0 ? (
                <div className={styles.posture}>
                  <h4 className={styles.subTitle}>{t('brandDetail.layoutPosture')}</h4>
                  <ul className={styles.postureList}>
                    {layout?.postureRules.map((r, i) => (
                      <li key={`posture-${i}`}>{r}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ) : null}

          {!compact && (samples.length > 0 || canUpload) ? (
            <section className={styles.section} aria-label={t('brandDetail.images')}>
              <div className={styles.dsHead}>
                <h3 className={styles.sectionTitle}>{t('brandDetail.images')}</h3>
                {samples.length > IMAGE_CAP ? (
                  <button
                    type="button"
                    className={styles.sectionAction}
                    onClick={() => setImagesExpanded((v) => !v)}
                  >
                    {imagesExpanded
                      ? t('brandDetail.viewLess')
                      : t('brandDetail.viewMore').replace('{count}', String(samples.length))}
                  </button>
                ) : null}
              </div>
              {samples.length > 0 ? (
                <div className={styles.gallery}>
                  {(imagesExpanded ? samples : samples.slice(0, IMAGE_CAP)).map((s, i) => {
                    const cap = s.caption || s.kind || kit.name;
                    return (
                      <figure key={`${s.url}-${i}`} className={styles.shot}>
                        <button
                          type="button"
                          className={styles.shotFrame}
                          onClick={() => setLightbox({ src: s.url, caption: cap })}
                          aria-label={cap}
                        >
                          <img src={s.url} alt={cap} loading="lazy" />
                        </button>
                        {s.caption || s.kind ? (
                          <figcaption className={styles.shotMeta}>
                            <span className={styles.shotCap}>{s.caption || s.kind}</span>
                            {s.caption && s.kind ? <span className={styles.shotKind}>{s.kind}</span> : null}
                          </figcaption>
                        ) : null}
                      </figure>
                    );
                  })}
                </div>
              ) : (
                emptyModule(t('ds.moduleEmptyImages'), 'image')
              )}
            </section>
          ) : null}

          {!compact && kit.system && dsKitUrl ? (
            <section className={styles.section} aria-label={t('brandDetail.designSystem')}>
              <div className={styles.dsHead}>
                <h3 className={styles.sectionTitle}>{t('brandDetail.designSystem')}</h3>
                {kit.system.indexUrl ? (
                  <a
                    className={styles.dsOpen}
                    href={kit.system.indexUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {t('brandDetail.openFullSystem')}
                    <ExternalGlyph />
                  </a>
                ) : null}
              </div>
              <div className={styles.dsFrameWrap}>
                <div className={styles.dsBar}>
                  <div className={styles.dsTabs}>
                    <button
                      type="button"
                      className={`${styles.dsTab} ${dsTheme === 'light' ? styles.dsTabActive : ''}`}
                      onClick={() => setDsTheme('light')}
                      aria-pressed={dsTheme === 'light'}
                    >
                      {t('brandDetail.themeLight')}
                    </button>
                    {kit.system.kitDarkUrl ? (
                      <button
                        type="button"
                        className={`${styles.dsTab} ${dsTheme === 'dark' ? styles.dsTabActive : ''}`}
                        onClick={() => setDsTheme('dark')}
                        aria-pressed={dsTheme === 'dark'}
                      >
                        {t('brandDetail.themeDark')}
                      </button>
                    ) : null}
                  </div>
                  <span className={styles.dsCap}>system/kit.html</span>
                </div>
                <iframe
                  key={dsKitUrl}
                  className={styles.dsFrame}
                  src={dsKitUrl}
                  loading="lazy"
                  sandbox=""
                  title={t('brandDetail.designSystem')}
                />
              </div>
              {tokens?.colorPrimary ? (
                <div className={styles.dsTokens}>
                  <TokenChip label="colorPrimary" hex={tokens.colorPrimary} />
                  {tokens.colorPrimaryBg ? <TokenChip label="colorPrimaryBg" hex={tokens.colorPrimaryBg} /> : null}
                  {tokens.colorPrimaryHover ? (
                    <TokenChip label="colorPrimaryHover" hex={tokens.colorPrimaryHover} />
                  ) : null}
                  {tokens.colorPrimaryActive ? (
                    <TokenChip label="colorPrimaryActive" hex={tokens.colorPrimaryActive} />
                  ) : null}
                  {tokens.fontSize != null ? <ValueChip label="fontSize" value={String(tokens.fontSize)} /> : null}
                  {tokens.borderRadius != null ? (
                    <ValueChip label="borderRadius" value={String(tokens.borderRadius)} />
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {!compact && kit.assets && kit.assets.length > 0 ? (
            <section className={styles.section} aria-label={t('brandDetail.brandAssets')}>
              <h3 className={styles.sectionTitle}>{t('brandDetail.brandAssets')}</h3>
              <div className={styles.assets}>
                {kit.assets.map((a) => (
                  <a
                    key={a.kind}
                    className={styles.asset}
                    href={a.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <div className={styles.assetFrame}>
                      <iframe
                        src={a.url}
                        loading="lazy"
                        tabIndex={-1}
                        aria-hidden="true"
                        sandbox=""
                        title={a.label}
                      />
                    </div>
                    <div className={styles.assetMeta}>
                      <span className={styles.assetName}>{a.label}</span>
                    </div>
                  </a>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}

      {lightbox ? (
        <div
          className={styles.lightbox}
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.caption}
          onClick={() => setLightbox(null)}
        >
          <button
            type="button"
            className={styles.lightboxClose}
            onClick={() => setLightbox(null)}
            aria-label={t('newBrand.close')}
          >
            <CloseGlyph />
          </button>
          <img
            className={styles.lightboxImg}
            src={lightbox.src}
            alt={lightbox.caption}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      ) : null}
    </div>
  );
}

function TokenChip({ label, hex }: { label: string; hex: string }) {
  return (
    <div className={styles.tok}>
      <span className={styles.tokSwatch} style={{ background: hex }} />
      <span className={styles.tokText}>
        <span className={styles.tokKey}>{label}</span>
        <span className={styles.tokHex}>{hex}</span>
      </span>
    </div>
  );
}

function ValueChip({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.tok}>
      <span className={styles.tokValue}>{value}</span>
      <span className={styles.tokKey}>{label}</span>
    </div>
  );
}

function ExternalGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden>
      <path
        d="M6 3.5h6.5V10M12.5 3.5L6.5 9.5M9 3.5H4.5a1 1 0 0 0-1 1V12a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
