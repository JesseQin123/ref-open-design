import type { ReactNode } from 'react';

import { joinClassNames } from './class-names.js';
import styles from './visually-hidden.module.css';

export interface VisuallyHiddenProps {
  children: ReactNode;
  className?: string;
}

export function VisuallyHidden({ children, className }: VisuallyHiddenProps) {
  return <span className={joinClassNames(styles.visuallyHidden, className)}>{children}</span>;
}
