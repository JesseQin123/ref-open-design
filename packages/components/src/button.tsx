import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';

import { joinClassNames } from './class-names.js';
import styles from './button.module.css';

export type ButtonVariant = 'default' | 'primary' | 'primary-ghost' | 'ghost' | 'subtle';
export type ButtonSize = 'default' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantClassNames: Record<ButtonVariant, string | undefined> = {
  default: undefined,
  primary: styles.primary,
  'primary-ghost': styles.primaryGhost,
  ghost: styles.ghost,
  subtle: styles.subtle,
};

const sizeClassNames: Record<ButtonSize, string | undefined> = {
  default: undefined,
  icon: styles.icon,
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, type = 'button', variant = 'default', size = 'default', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={joinClassNames(
        styles.button,
        variantClassNames[variant],
        sizeClassNames[size],
        className,
      )}
      {...props}
    />
  );
});
