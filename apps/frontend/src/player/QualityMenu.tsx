import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Settings } from 'lucide-react';
import type { PlaybackRendition } from '@ugn/contracts';
import { AUTO, type Quality } from './playbackSource';

interface Props {
  renditions: PlaybackRendition[];
  selected: Quality;
  /** Frames on screen now, so "Auto" can say what it picked. */
  playingWidth: number;
  playingHeight: number;
  onSelect(quality: Quality): void;
  onOpenChange(open: boolean): void;
  buttonClassName: string;
}

/** Rendition names follow the short side ("720p" is 1280x720 or 720x1280). */
export function qualityName(width: number, height: number): string | null {
  return width > 0 && height > 0 ? `${Math.min(width, height)}p` : null;
}

/** A menu button with radio items (WAI-ARIA menu pattern): arrows move, Enter/Space pick, Esc closes. */
export function QualityMenu({ renditions, selected, playingWidth, playingHeight, onSelect, onOpenChange, buttonClassName }: Props) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const menuId = useId();
  const playing = qualityName(playingWidth, playingHeight);
  const options = [
    { value: AUTO, label: playing ? `Auto (${playing})` : 'Auto' },
    ...renditions.map((r) => ({ value: r.name, label: r.name })),
  ];
  const current = selected === AUTO ? 'Auto' : selected;

  const setOpenAndNotify = (next: boolean) => {
    setOpen(next);
    onOpenChange(next);
  };

  const close = (refocus: boolean) => {
    setOpenAndNotify(false);
    if (refocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    // Focus the checked item when the menu opens.
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const onMenuKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
    switch (e.key) {
      case 'ArrowDown':
        focusAt(index + 1);
        break;
      case 'ArrowUp':
        focusAt(index - 1);
        break;
      case 'Home':
        focusAt(0);
        break;
      case 'End':
        focusAt(items.length - 1);
        break;
      case 'Escape':
        close(true);
        break;
      case 'Tab':
        close(false);
        return; // let focus move on
      default:
        return;
    }
    // Keep the player's own shortcuts (arrows seek, etc.) out of the menu.
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        className={`${buttonClassName} w-auto gap-1 px-2 text-xs font-semibold`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Quality: ${options.find((o) => o.value === selected)?.label ?? current}`}
        onClick={() => setOpenAndNotify(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            setOpenAndNotify(true);
          }
        }}
      >
        <Settings className="size-5" aria-hidden />
        <span className="hidden @md:inline">{selected === AUTO && playing ? playing : current}</span>
      </button>
      {open && (
        <ul
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="Quality"
          className="absolute bottom-full right-0 z-20 mb-2 min-w-36 rounded-lg border border-ink-700 bg-ink-900/95 py-1 shadow-xl backdrop-blur"
          onKeyDown={onMenuKeyDown}
        >
          {options.map((o) => (
            <li
              key={o.value}
              role="menuitemradio"
              aria-checked={o.value === selected}
              tabIndex={-1}
              className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-white outline-none hover:bg-ink-800 focus:bg-ink-800"
              onClick={() => {
                onSelect(o.value);
                close(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  onSelect(o.value);
                  close(true);
                }
              }}
            >
              <Check className={`size-4 ${o.value === selected ? 'text-primary' : 'invisible'}`} aria-hidden />
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
