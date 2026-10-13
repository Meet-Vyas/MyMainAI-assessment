import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ui } from './ui';

interface Props {
  onConfirm: () => void | Promise<void>;
  children: ReactNode;
  confirmLabel: string;
  disabled?: boolean;
  title?: string;
}

/**
 * Two-step destructive button: the first click arms it ("Confirm delete?") for a few seconds.
 * Keeps confirmation inline and keyboard-friendly, without a blocking browser dialog.
 */
export function ConfirmButton({ onConfirm, children, confirmLabel, disabled, title }: Props) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const click = async () => {
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    clearTimeout(timer.current);
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  return (
    <button type="button" className={armed ? ui.btnPrimary : ui.btnDanger} onClick={click} disabled={disabled || busy} title={title}>
      {armed ? confirmLabel : children}
    </button>
  );
}
