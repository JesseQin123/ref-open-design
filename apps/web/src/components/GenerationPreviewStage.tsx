import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import type { GenerationPreviewModel } from '../runtime/generation-preview';
import { formatGenerationElapsed } from '../runtime/generation-preview';
import { Icon } from './Icon';
import styles from './GenerationPreviewStage.module.css';

type Props = {
  model: GenerationPreviewModel;
  onRetry?: (() => void) | undefined;
};

export function GenerationPreviewStage({ model, onRetry }: Props) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());

  const generating = model.phase === 'generating';

  useEffect(() => {
    if (!generating) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [generating, model.startedAt]);

  const elapsedSec = Math.max(0, Math.round((now - model.startedAt) / 1000));
  const elapsedLabel = formatGenerationElapsed(elapsedSec);

  const stepLabels: Record<GenerationPreviewModel['steps'][number]['id'], string> = {
    understand: t('generationPreview.stepUnderstand'),
    generate: t('generationPreview.stepGenerate'),
    prepare: t('generationPreview.stepPrepare'),
  };

  const title =
    model.phase === 'failed'
      ? t('generationPreview.failedTitle')
      : model.phase === 'stopped'
        ? t('generationPreview.stoppedTitle')
        : model.phase === 'awaiting-input'
          ? t('generationPreview.awaitingTitle')
          : t('generationPreview.title');

  const lead =
    model.phase === 'failed'
      ? model.errorMessage || t('generationPreview.failedFallback')
      : model.phase === 'stopped'
        ? t('generationPreview.stoppedLead')
        : model.phase === 'awaiting-input'
          ? t('generationPreview.awaitingLead')
          : model.activityLabel || t('generationPreview.footnote');

  const markIcon =
    model.phase === 'failed' ? 'close' : model.phase === 'stopped' ? 'stop' : 'sparkles';

  return (
    <section
      className={styles.stage}
      data-testid="generation-preview-stage"
      data-phase={model.phase}
      aria-live="polite"
      aria-busy={generating}
    >
      <div className={styles.mark} data-active={generating} aria-hidden>
        <Icon name={markIcon} size={24} />
      </div>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.lead} data-live={generating && Boolean(model.activityLabel)}>
        {lead}
      </p>
      <div
        className={styles.progress}
        data-active={generating}
        role="progressbar"
        aria-label={t('generationPreview.progressAria', { percent: model.progressPercent })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={model.progressPercent}
      >
        <span style={{ width: `${model.progressPercent}%` }} />
      </div>
      <ol className={styles.steps}>
        {model.steps
          .filter((step) => step.status !== 'pending')
          .map((step) => (
          <li key={step.id} className={styles.step} data-status={step.status}>
            <span className={styles.stepIcon} aria-hidden>
              {step.status === 'succeeded' ? (
                <Icon name="check" size={12} />
              ) : step.status === 'failed' ? (
                <Icon name="close" size={12} />
              ) : (
                <span className={styles.stepDot} data-running={step.status === 'running' && generating} />
              )}
            </span>
            <span className={styles.stepLabel}>{stepLabels[step.id]}</span>
          </li>
        ))}
      </ol>
      {generating ? (
        <div className={styles.meta}>
          <span data-testid="generation-preview-elapsed">
            {t('generationPreview.elapsed', { elapsed: elapsedLabel })}
          </span>
          <span className={styles.metaDivider} aria-hidden>
            ·
          </span>
          <span>{t('generationPreview.estimate')}</span>
        </div>
      ) : null}
      {model.phase === 'failed' && onRetry ? (
        <button
          type="button"
          className={styles.retry}
          data-testid="generation-preview-retry"
          onClick={onRetry}
        >
          {t('generationPreview.retry')}
        </button>
      ) : null}
    </section>
  );
}
