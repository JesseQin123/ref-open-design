import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useT } from '../i18n';
import { useAnalytics } from '../analytics/provider';
import {
  trackStudioOnboardingHintClick,
  trackStudioOnboardingHintSurfaceView,
} from '../analytics/events';
import {
  hasSeenFirstArtifactHint,
  markFirstArtifactHintSeen,
} from '../onboarding/first-artifact-hint';
import { Icon } from './Icon';
import styles from './FirstArtifactHint.module.css';

// One-time, one-line hint shown when a new user's first previewable artifact
// appears in Studio (spec §8.3). The once-ever budget is spent when the USER
// dismisses it — not on show — so parent-gate flicker (a transient files
// refresh or streaming blip unmounting and remounting this component) can't
// silently burn the hint before anyone reads it. Remounts before dismissal
// simply show it again, which matches the spec: visible until closed or used.
// Kept deliberately small and non-modal so it never stacks as a second guide
// against the post-turn NextStepActions card (spec §8.5: one main guide at a
// time) — it sits in the preview corner while NextStepActions lives in the
// chat.
export function FirstArtifactHint() {
  const t = useT();
  const analytics = useAnalytics();
  const reducedMotion = useReducedMotion();
  const [visible, setVisible] = useState(() => !hasSeenFirstArtifactHint());
  // Delayed mount replaces an opacity fade: the card appears fully opaque
  // (no see-through frame, per review) — the 600ms settle window is simply
  // "not rendered yet".
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(true), 600);
    return () => window.clearTimeout(timer);
  }, []);
  const firedRef = useRef(false);

  useEffect(() => {
    if (!visible || firedRef.current) return;
    firedRef.current = true;
    trackStudioOnboardingHintSurfaceView(analytics.track, {
      page_name: 'chat_panel',
      area: 'onboarding_first_artifact_hint',
      hint_type: 'view_artifact',
    });
  }, [visible, analytics.track]);

  if (!visible || !settled) return null;

  function dismiss() {
    trackStudioOnboardingHintClick(analytics.track, {
      page_name: 'chat_panel',
      area: 'onboarding_first_artifact_hint',
      element: 'dismiss',
      hint_type: 'view_artifact',
    });
    // Spend the once-ever budget on the user's own close action.
    markFirstArtifactHintSeen();
    setVisible(false);
  }

  return (
    // Motion-driven entrance (the repo already ships `motion`), fully opaque
    // throughout: the card DROPS from the toolbar and settles (easeOut — set
    // down gently, same vertical axis as what follows), holds a beat, then
    // gives two equal 4px knocks with a pause between them (easeInOut).
    // Skipped entirely under prefers-reduced-motion.
    <motion.div
      className={styles.root}
      role="status"
      data-testid="first-artifact-hint"
      initial={reducedMotion ? false : { y: -28 }}
      animate={reducedMotion ? { y: 0 } : { y: [-28, 0, 0, -4, 0, 0, -4, 0] }}
      transition={
        reducedMotion
          ? { duration: 0 }
          : {
              duration: 2.4,
              times: [0, 0.19, 0.32, 0.44, 0.56, 0.64, 0.76, 0.88],
              ease: [
                'easeOut',
                'linear',
                'easeInOut',
                'easeInOut',
                'linear',
                'easeInOut',
                'easeInOut',
              ],
            }
      }
    >
      <span className={styles.icon} aria-hidden>
        <Icon name="sparkles" size={18} />
      </span>
      <div className={styles.body}>
        <span className={styles.title}>{t('studio.firstArtifactHint.title')}</span>
        <span className={styles.text}>{t('studio.firstArtifactHint.body')}</span>
      </div>
      <button
        type="button"
        className={styles.dismiss}
        onClick={dismiss}
        aria-label={t('studio.firstArtifactHint.dismiss')}
      >
        <Icon name="close" size={15} />
      </button>
    </motion.div>
  );
}
