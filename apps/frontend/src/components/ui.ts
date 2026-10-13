/** Shared class names so buttons and fields look the same everywhere. */
const focus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950';
const btnBase = `inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${focus}`;

export const ui = {
  focus,
  btnPrimary: `${btnBase} bg-primary text-white hover:bg-primary-hover`,
  btnSecondary: `${btnBase} border border-ink-700 bg-ink-800 text-white hover:border-ink-500`,
  btnGhost: `${btnBase} text-ink-300 hover:bg-ink-800 hover:text-white`,
  btnDanger: `${btnBase} border border-primary/40 text-primary hover:bg-primary/10`,
  iconBtn: `inline-flex size-9 items-center justify-center rounded-lg text-ink-300 hover:bg-ink-800 hover:text-white disabled:opacity-40 ${focus}`,
  input: `w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-white placeholder:text-ink-500 focus:border-primary ${focus}`,
  label: 'mb-1 block text-sm font-medium text-white',
  error: 'mt-1 text-sm text-red-400',
  card: 'rounded-xl border border-ink-800 bg-ink-900 p-4 sm:p-5',
};
