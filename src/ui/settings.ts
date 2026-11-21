/**
 * Ajustes: three tabs (Juego · Reglas · Imagen y sonido), ported from Kudominoes. The rule list is
 * rendered generically from the engine's RULE_SETTINGS descriptors, filtered by mode and grouped by
 * `group`, so new variants need no UI work.
 */
import type { AppSettings, CardBack, GameMode, RulePreset, RuleSettings, SettingDescriptor, SettingValue, TableStyle } from '../contracts';
import { CARD_BACKS, TABLE_STYLES } from '../contracts';
import { createAvatarEditor, type FaceSpec } from 'kuavatars';
import { cardBackSvg, tableSwatchSvg } from './cardArt';
import { deleteProfile, loadProfiles, MAX_NAME, MAX_PROFILES, saveProfile } from '../app/ruleProfiles';
import { CHAT_GESTURES, type ChatGesture } from '../net/protocol';
import { staticFace } from './avatarAdapter';
import { gestureLabel, MAX_GESTURES, sanitizeGestures } from './chat';
import { h } from './dom';
import { screenHeader } from './howto';
import { enhanceHScroll } from './hscroll';
import { loc, t, tMaybe, type Key } from './i18n';
import { ICONS, segmented, toggle } from './overlay';

/** up to 5 gestures for the in-game chat: tiles showing the player's face making each one */
function gesturePicker(initial: ChatGesture[], face: FaceSpec | number, onChange: (v: ChatGesture[]) => void): HTMLElement {
  let picked = [...initial];
  const count = h('div.gp-count', { 'aria-live': 'polite' });
  const tiles = CHAT_GESTURES.map((g) => {
    const label = gestureLabel(g);
    const b = h('button.gp-tile', { type: 'button', 'aria-pressed': 'false', 'aria-label': label, title: label }, h('span.gp-face', staticFace(face, 'idle', '', g)), h('span.gp-lbl', label), h('span.gp-num', { 'aria-hidden': 'true' }));
    b.addEventListener('click', () => {
      if (picked.includes(g)) picked = picked.filter((x) => x !== g);
      else if (picked.length < MAX_GESTURES) picked = [...picked, g];
      else return;
      sync();
      onChange([...picked]);
    });
    return { g, b };
  });
  function sync(): void {
    for (const { g, b } of tiles) {
      const i = picked.indexOf(g);
      b.setAttribute('aria-pressed', String(i >= 0));
      (b.querySelector('.gp-num') as HTMLElement).textContent = i >= 0 ? String(i + 1) : '';
      b.toggleAttribute('disabled', i < 0 && picked.length >= MAX_GESTURES);
    }
    count.textContent = t('settings.gesturesCount', { n: picked.length });
  }
  sync();
  return h('div.gp', h('div.gp-grid', ...tiles.map((x) => x.b)), count);
}

export type SettingsTab = 'game' | 'rules' | 'av';
const ALL_TABS: SettingsTab[] = ['game', 'rules', 'av'];
const MODES: GameMode[] = ['classic', 'action', 'cyclone', 'sideBySide'];

export interface SettingsOpts {
  settings: AppSettings;
  ruleDescriptors: SettingDescriptor[];
  presets: RulePreset[];
  /** the mode the Reglas tab opens on */
  rulesMode?: GameMode;
  matchInProgress: boolean;
  confirm(o: { title: string; body: string; ok: string; cancel: string; danger?: boolean }): Promise<boolean>;
  /** called with the full new settings object after every change */
  onChange(next: AppSettings, key: keyof AppSettings): void;
  onBack(): void;
  /** the level auto quality runs at right now */
  resolvedQuality?(): AppSettings['quality'];
  onAbout?(): void;
}

// ───────────────────────── small pieces ─────────────────────────

let rowSeq = 0;

/** a settings row; `help` sits behind a small ⓘ button that opens a floating tooltip */
function row(label: string, control: Node, help?: string, stack = false): HTMLElement {
  let info: HTMLButtonElement | null = null;
  if (help) {
    info = h('button.info-btn', { type: 'button', 'aria-expanded': 'false', 'aria-label': `${t('settings.info')}: ${label}`, title: t('settings.info') }, 'i');
    info.addEventListener('click', () => toggleTip(info!, help));
  }
  return h('div.set-row', { class: stack ? 'stack' : '' }, h('div.set-text', h('div.set-label-line', h('span.set-label', label), info)), h('div.set-ctl', control));
}

// ── rule explanation tooltip: one floating bubble, opened by tapping ⓘ ──
let tipEl: HTMLElement | null = null;
let tipFor: HTMLElement | null = null;
const tipOff = (e: Event) => {
  if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return;
  if (e.type === 'pointerdown' && (tipEl?.contains(e.target as Node) || tipFor?.contains(e.target as Node))) return;
  closeTip();
};
function closeTip(): void {
  tipFor?.setAttribute('aria-expanded', 'false');
  tipEl?.remove();
  tipEl = tipFor = null;
  document.removeEventListener('pointerdown', tipOff, true);
  document.removeEventListener('keydown', tipOff, true);
  document.removeEventListener('scroll', tipOff, true);
  window.removeEventListener('resize', tipOff);
}
function toggleTip(anchor: HTMLElement, text: string): void {
  if (tipFor === anchor) return closeTip();
  closeTip();
  const id = `tip-${++rowSeq}`;
  const el = h('div.tip', { id, role: 'tooltip' }, h('div.tip-text', text), h('div.tip-arrow'));
  document.body.append(el);
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-describedby', id);
  // above the ⓘ when it fits, else below; kept inside the screen with a 12px margin
  const a = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  const cx = a.left + a.width / 2;
  const left = Math.max(12, Math.min(innerWidth - w - 12, cx - w / 2));
  const above = a.top - hgt - 10 > 12;
  el.style.left = `${left}px`;
  el.style.top = `${above ? a.top - hgt - 4 : a.bottom + 4}px`;
  el.classList.add(above ? 'above' : 'below');
  el.style.setProperty('--ax', `${cx - left}px`);
  tipEl = el;
  tipFor = anchor;
  document.addEventListener('pointerdown', tipOff, true);
  document.addEventListener('keydown', tipOff, true);
  document.addEventListener('scroll', tipOff, true);
  window.addEventListener('resize', tipOff);
}

function hscroll(items: HTMLElement[], selected: number, label: string): HTMLElement {
  const track = h('div.hscroll', { role: 'radiogroup', 'aria-label': label });
  track.append(...items);
  const wrap = h('div.hscroll-wrap', track);
  enhanceHScroll(track);
  const ro = new ResizeObserver(() => {
    if (!track.isConnected || !track.clientWidth) return;
    const it = items[selected];
    if (it && !track.dataset.placed) {
      track.dataset.placed = '1';
      track.scrollLeft = Math.max(0, it.offsetLeft - (track.clientWidth - it.offsetWidth) / 2);
      ro.disconnect();
    }
  });
  ro.observe(track);
  return wrap;
}

function radioItems<T>(values: T[], value: T, make: (v: T, on: boolean) => Node[], aria: (v: T) => string, onChange: (v: T) => void, cls: string): HTMLButtonElement[] {
  const items: HTMLButtonElement[] = values.map((v) => {
    const b = h('button', { type: 'button', class: cls, role: 'radio', 'aria-checked': String(v === value), 'aria-label': aria(v), title: aria(v) });
    b.append(...make(v, v === value));
    b.addEventListener('click', () => {
      if (v === value) return;
      const prev = values.indexOf(value);
      value = v;
      items[prev].setAttribute('aria-checked', 'false');
      items[prev].replaceChildren(...make(values[prev], false));
      b.setAttribute('aria-checked', 'true');
      b.replaceChildren(...make(v, true));
      onChange(v);
    });
    return b;
  });
  return items;
}

/** the KuAvatars editor: players build their own face (FaceSpec) */
function faceEditor(value: number | FaceSpec, onChange: (v: FaceSpec) => void): HTMLElement {
  const box = h('div.face-editor');
  createAvatarEditor(box, { value, onChange, moods: false, gestures: false });
  return box;
}

function swatchPicker<T extends string>(values: T[], value: T, art: (v: T) => string, name: (v: T) => string, label: string, onChange: (v: T) => void, kind: string): HTMLElement {
  const items = radioItems(values, value, (v) => [h('span.swatch-img', { html: art(v) }), h('span.swatch-name', name(v))], name, onChange, `swatch ${kind}`);
  return hscroll(items, values.indexOf(value), label);
}

const TAB_ICONS: Record<SettingsTab, string> = {
  // two cards
  game: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3.5" y="5" width="10" height="15" rx="2.2" fill="none" stroke="currentColor" stroke-width="2" transform="rotate(-10 8.5 12.5)"/><rect x="10.5" y="4" width="10" height="15" rx="2.2" fill="currentColor" opacity=".9" transform="rotate(8 15.5 11.5)"/></svg>',
  rules: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="2.5" width="16" height="19" rx="2.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7.4 8.2l1.5 1.5 2.6-2.8M7.4 14.6l1.5 1.5 2.6-2.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.6 8.6h3.4M13.6 15h3.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  av: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 6.5h16M4 12h16M4 17.5h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".55"/><circle cx="9" cy="6.5" r="2.4" fill="currentColor"/><circle cx="15.5" cy="12" r="2.4" fill="currentColor"/><circle cx="7.5" cy="17.5" r="2.4" fill="currentColor"/></svg>',
};

function prettyGroup(g: string): string {
  return tMaybe(`rulesGroup.${g}`) ?? g.replace(/[-_.]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// ───────────────────────── rules helpers (generic over descriptors) ─────────────────────────

const optionLabel = (o: NonNullable<SettingDescriptor['options']>[number], short = false) => loc(short ? (o.short ?? o.label) : o.label);

export const descriptorsForMode = (all: SettingDescriptor[], mode: GameMode) => all.filter((d) => !d.modes || d.modes.includes(mode));

const isOff = (v: SettingValue) => v === 0 || v === 'off' || v === false;

/** one-line summary of rules: the non-default-looking values ("7 cartas · 500 puntos · Escudo …") */
export function rulesSummary(list: SettingDescriptor[], rules: RuleSettings): string {
  const parts: string[] = [];
  for (const d of list) {
    const v = rules[d.key] ?? d.default;
    const name = loc(d.short ?? d.label);
    if (d.type === 'toggle') {
      if (v === true) parts.push(name);
      continue;
    }
    if (isOff(v)) continue;
    const o = d.options?.find((x) => x.value === v);
    if (!o) continue;
    const txt = optionLabel(o, true);
    parts.push(/^[\d+×]/.test(txt) && !/\D{3,}/.test(txt) ? `${name} ${txt}` : txt);
  }
  const out = parts.length ? parts.join(' · ') : t('common.off');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

export function sameAs(rules: RuleSettings, preset: RuleSettings, descriptors: SettingDescriptor[]): boolean {
  return descriptors.every((d) => (rules[d.key] ?? d.default) === (preset[d.key] ?? d.default));
}

/** name of the mode's preset when the rules match it, else "Personalizado" */
export function presetName(presets: RulePreset[], descriptors: SettingDescriptor[], rules: RuleSettings, mode: GameMode): string {
  const ds = descriptorsForMode(descriptors, mode);
  const p = presets.find((x) => x.id === mode && sameAs(rules, x.rules, ds));
  return p ? loc(p.label) : t('settings.preset.custom');
}

function aboutRow(onClick: () => void): HTMLElement {
  const b = h(
    'button.about-row',
    { type: 'button' },
    h('span.about-row-icon', { html: ICONS.info }),
    h('span.about-row-label', t('menu.about')),
    h('span.about-row-ver', __APP_VERSION__),
    h('span.rg-chev', { 'aria-hidden': 'true' }),
  );
  b.addEventListener('click', onClick);
  return h('section.card.set-card.about-card', b);
}

const PLUS_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
const TRASH_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M9.5 7V4.8h5V7M6.8 7l.9 12.2h8.6L17.2 7M10.2 10.5v5.5M13.8 10.5v5.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export interface RuleSelectItem {
  label: string;
  on: boolean;
  /** "Personalizado": shown as the current value, not pickable */
  custom?: boolean;
  pick?: () => void;
}

export function ruleSelect(items: RuleSelectItem[], label: string, variant?: 'soft'): HTMLElement {
  const cur = items.find((i) => i.on) ?? items[0];
  const listId = `rsel-${++rowSeq}`;
  const btnEl = h(
    'button.rsel-btn',
    { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-label': `${label}: ${cur.label}` },
    h('span.rsel-v', { class: cur.custom ? 'custom' : '' }, cur.label),
    h('span.rsel-chev', { 'aria-hidden': 'true' }),
  );
  const opts = items
    .filter((i) => !i.custom)
    .map((i) => {
      const o = h('li.rsel-opt', { role: 'option', tabindex: -1, 'aria-selected': String(i.on) }, h('span.rsel-check', { 'aria-hidden': 'true' }), h('span', i.label));
      o.addEventListener('click', () => {
        close();
        if (!i.on) i.pick?.();
      });
      return o;
    });
  const list = h('ul.rsel-list', { id: listId, role: 'listbox', 'aria-label': label, hidden: true }, ...opts);
  const wrap = h('div.rsel', { class: variant ?? '' }, btnEl, list);
  const outside = (e: Event) => {
    if (!wrap.contains(e.target as Node)) close();
  };
  function open(): void {
    // open upward when the space below is short (the new-game footer sits at the bottom)
    const r = wrap.getBoundingClientRect();
    wrap.classList.toggle('up', innerHeight - r.bottom < 220 && r.top > innerHeight - r.bottom);
    list.hidden = false;
    btnEl.setAttribute('aria-expanded', 'true');
    wrap.classList.add('open');
    document.addEventListener('pointerdown', outside, true);
    const sel = opts.find((o) => o.getAttribute('aria-selected') === 'true') ?? opts[0];
    sel?.focus({ preventScroll: true });
  }
  function close(focusBtn = false): void {
    if (list.hidden) return;
    list.hidden = true;
    btnEl.setAttribute('aria-expanded', 'false');
    wrap.classList.remove('open');
    document.removeEventListener('pointerdown', outside, true);
    if (focusBtn) btnEl.focus();
  }
  btnEl.addEventListener('click', () => (list.hidden ? open() : close()));
  btnEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open();
    }
  });
  list.addEventListener('keydown', (e) => {
    const i = opts.indexOf(document.activeElement as HTMLLIElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      opts[(i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      (document.activeElement as HTMLElement)?.click();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      close(true);
    }
  });
  return wrap;
}

// ───────────────────────── screen ─────────────────────────

export function buildSettings(o: SettingsOpts): HTMLElement {
  let s: AppSettings = structuredClone(o.settings);
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => {
    s = { ...s, [k]: v };
    o.onChange(s, k);
  };
  const seg = <K extends 'language' | 'animationSpeed'>(k: K, values: AppSettings[K][], label: (v: AppSettings[K]) => string) =>
    segmented(
      values.map((v) => ({ value: v, label: label(v) })),
      s[k],
      (v) => set(k, v),
      t(`settings.${k}` as Key),
    );

  const name = h('input.text-input', { type: 'text', maxlength: 14, value: s.playerName, placeholder: t('seat.you'), autocomplete: 'off', enterkeyhint: 'done', 'aria-label': t('settings.name') });
  name.addEventListener('change', () => set('playerName', name.value.trim().slice(0, 14)));
  name.addEventListener('keydown', (e) => e.key === 'Enter' && name.blur());

  // ── Juego ──
  const tabGame = () =>
    h(
      'div.set-tab-body',
      // your name and face can't change mid-game (the other players already know you by them)
      o.matchInProgress
        ? h('section.card.set-card', h('p.warn', { role: 'note' }, t('settings.profileLocked')))
        : h(
            'section.card.set-card',
            row(t('settings.name'), name),
            row(t('settings.avatarFace'), faceEditor(s.avatarFace ?? 0, (v) => set('avatarFace', v)), undefined, true),
          ),
      // a preference like sound, not identity: editable mid-game
      h('section.card.set-card', row(t('settings.gestures'), gesturePicker(sanitizeGestures(s.gestures), s.avatarFace ?? 0, (v) => set('gestures', v)), t('settings.gesturesHelp'), true)),
      h(
        'section.card.set-card',
        row(t('settings.language'), seg('language', ['es', 'en'], (v) => (v === 'es' ? 'Español' : 'English'))),
        row(t('settings.animationSpeed'), seg('animationSpeed', ['normal', 'fast'], (v) => t(`settings.animationSpeed.${v}` as Key))),
      ),
      o.onAbout ? aboutRow(o.onAbout) : null,
    );

  // ── Imagen y sonido ──
  type QChoice = 'auto' | AppSettings['quality'];
  const qualityCtl = () => {
    const now = h('div.set-sub', { 'aria-live': 'polite' });
    const showNow = () => {
      const auto = s.qualityMode !== 'manual';
      now.hidden = !auto;
      if (auto) now.textContent = t('settings.quality.now', { q: t(`settings.quality.${o.resolvedQuality?.() ?? s.quality}` as Key) });
    };
    const ctl = segmented<QChoice>(
      (['auto', 'low', 'medium', 'high'] as QChoice[]).map((v) => ({ value: v, label: t(`settings.quality.${v}` as Key) })),
      s.qualityMode === 'manual' ? s.quality : 'auto',
      (v) => {
        if (v === 'auto') set('qualityMode', 'auto');
        else {
          s = { ...s, qualityMode: 'manual', quality: v };
          o.onChange(s, 'quality');
        }
        showNow();
      },
      t('settings.quality'),
    );
    ctl.classList.add('seg-quality');
    showNow();
    return h('div.set-ctl-col', ctl, now);
  };
  const tabAv = () =>
    h(
      'div.set-tab-body',
      h(
        'section.card.set-card',
        row(t('settings.quality'), qualityCtl(), undefined, true),
        row(
          t('settings.tableStyle'),
          swatchPicker<TableStyle>(TABLE_STYLES, s.tableStyle ?? 'teal', (v) => tableSwatchSvg(v), (v) => t(`settings.table.${v}` as Key), t('settings.tableStyle'), (v) => set('tableStyle', v), 'table'),
          undefined,
          true,
        ),
        row(
          t('settings.cardBack'),
          swatchPicker<CardBack>(CARD_BACKS, s.cardBack ?? 'ku', (v) => cardBackSvg(v, 38), (v) => t(`settings.back.${v}` as Key), t('settings.cardBack'), (v) => set('cardBack', v), 'back'),
          undefined,
          true,
        ),
        row(t('settings.avatars'), toggle(s.avatars !== false, (v) => set('avatars', v), t('settings.avatars'))),
        row(t('settings.reducedMotion'), toggle(!!s.reducedMotion, (v) => set('reducedMotion', v), t('settings.reducedMotion'))),
      ),
      h(
        'section.card.set-card',
        row(t('settings.sound'), toggle(s.sound, (v) => set('sound', v), t('settings.sound'))),
        row(t('settings.voice'), toggle(s.voice, (v) => set('voice', v), t('settings.voice'))),
        row(t('settings.music'), toggle(s.music, (v) => set('music', v), t('settings.music'))),
        'vibrate' in navigator ? row(t('settings.vibration'), toggle(s.vibration, (v) => set('vibration', v), t('settings.vibration'))) : null,
      ),
    );

  // ── Reglas: mode selector + preset chip + collapsible groups ──
  let openGroup: string | null = null;
  let naming = false;
  let rmode: GameMode = o.rulesMode ?? s.mode ?? 'classic';
  const rulesWrap = h('div.set-tab-body');
  const renderRules = () => {
    const descriptors = descriptorsForMode(o.ruleDescriptors, rmode);
    const groups = new Map<string, SettingDescriptor[]>();
    for (const d of descriptors) {
      if (!groups.has(d.group)) groups.set(d.group, []);
      groups.get(d.group)!.push(d);
    }
    const preset = o.presets.find((p) => p.id === rmode)!;
    const cur: RuleSettings = { ...(s.rulesByMode?.[rmode] ?? preset.rules) };
    const isPreset = sameAs(cur, preset.rules, descriptors);
    const store = (rules: RuleSettings) => {
      const rulesByMode = { ...(s.rulesByMode ?? {}), [rmode]: rules };
      s = { ...s, rulesByMode, rules: rmode === (s.mode ?? 'classic') ? { ...rules } : s.rules };
      o.onChange(s, 'rulesByMode');
    };
    const setRule = (k: string, v: SettingValue) => {
      store({ ...cur, [k]: v });
      renderRules();
    };
    const restore = () => {
      if (isPreset) return;
      store({ ...preset.rules });
      renderRules();
    };
    const mine = loadProfiles().filter((p) => p.mode === rmode);
    const active = isPreset ? null : (mine.find((p) => sameAs(cur, p.rules, descriptors)) ?? null);
    const applyProfile = (p: { name: string; rules: RuleSettings }) => {
      store({ ...p.rules });
      renderRules();
    };
    // save the current rules as a profile / delete the selected one
    let profileCtl: HTMLElement | null = null;
    let profileAct: HTMLElement | null = null;
    if (naming) {
      const input = h('input.text-input', { type: 'text', maxlength: MAX_NAME, placeholder: t('settings.profileName'), autocomplete: 'off', enterkeyhint: 'done', 'aria-label': t('settings.profileName') }) as HTMLInputElement;
      const ok = h('button.btn.primary.profile-ok', { type: 'button' }, t('settings.profileSaveOk'));
      const cancel = h('button.btn.secondary.profile-cancel', { type: 'button' }, t('common.cancel'));
      const commit = async () => {
        const n = input.value.trim();
        if (!n) return input.focus();
        if (mine.some((p) => p.name.toLocaleLowerCase() === n.toLocaleLowerCase()) && !(await o.confirm({ title: t('profiles.overwriteTitle', { name: n }), body: t('profiles.overwriteBody'), ok: t('profiles.overwriteOk'), cancel: t('common.cancel') }))) return;
        saveProfile(n, rmode, cur);
        naming = false;
        renderRules();
      };
      ok.addEventListener('click', () => void commit());
      cancel.addEventListener('click', () => {
        naming = false;
        renderRules();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void commit();
        if (e.key === 'Escape') cancel.click();
      });
      profileCtl = h('div.profile-form', input, h('div.profile-form-btns', cancel, ok));
      setTimeout(() => input.focus(), 50);
    } else {
      if (active) {
        const lb = t('settings.profileDelete', { name: active.name });
        profileAct = h('button.icon-btn.rsel-act.danger', { type: 'button', 'aria-label': lb, title: lb, html: TRASH_SVG });
        profileAct.addEventListener('click', async () => {
          const ok = await o.confirm({ title: t('settings.profileDeleteTitle', { name: active.name }), body: t('settings.profileDeleteBody'), ok: t('settings.profileDeleteOk'), cancel: t('common.cancel'), danger: true });
          if (!ok) return;
          deleteProfile(active.id);
          renderRules();
        });
      } else {
        // + saves the current rules (disabled on the built-in preset or when the list is full)
        const lb = t('settings.profileSave');
        const canSave = !isPreset && loadProfiles().length < MAX_PROFILES;
        profileAct = h('button.icon-btn.rsel-act', { type: 'button', 'aria-label': lb, title: lb, html: PLUS_SVG, disabled: canSave ? undefined : true });
        profileAct.addEventListener('click', () => {
          naming = true;
          renderRules();
        });
      }
    }

    const openMode = (m: GameMode, rules: RuleSettings) => {
      rmode = m;
      openGroup = null;
      naming = false;
      const rulesByMode = { ...(s.rulesByMode ?? {}), [m]: { ...rules } };
      s = { ...s, rulesByMode, rules: m === (s.mode ?? 'classic') ? { ...rules } : s.rules };
      o.onChange(s, 'rulesByMode');
      renderRules();
    };

    const groupEls = [...groups].map(([g, list]) => {
      const open = openGroup === g;
      const bodyId = `rg-${g.replace(/\W/g, '')}`;
      const head = h(
        'button.rg-head',
        { type: 'button', 'aria-expanded': String(open), 'aria-controls': bodyId },
        h('span.rg-text', h('span.rg-title', prettyGroup(g)), h('span.rg-sum', rulesSummary(list, cur))),
        h('span.rg-chev', { 'aria-hidden': 'true' }),
      );
      head.addEventListener('click', () => {
        openGroup = open ? null : g;
        renderRules();
        if (openGroup) requestAnimationFrame(() => rulesWrap.querySelector(`#${bodyId}`)?.parentElement?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
      });
      const body = h('div.rg-body', { id: bodyId, hidden: !open });
      if (open)
        for (const d of list) {
          const val = cur[d.key] ?? d.default;
          const many = d.type === 'select' && (d.options?.length ?? 0) > 2;
          // three or more options: a quiet dropdown (the teal one is for the rule set)
          const ctl =
            d.type === 'toggle'
              ? toggle(Boolean(val), (v) => setRule(d.key, v), loc(d.label))
              : many
                ? ruleSelect((d.options ?? []).map((op) => ({ label: optionLabel(op), on: op.value === val, pick: () => setRule(d.key, op.value) })), loc(d.label), 'soft')
                : segmented(
                  (d.options ?? []).map((op) => ({ value: op.value, label: optionLabel(op) })),
                  val,
                  (v) => setRule(d.key, v),
                  loc(d.label),
                );
          const longOpts = d.type === 'select' && !many && ((d.options ?? []).some((op) => optionLabel(op).length > 9));
          body.append(row(loc(d.label), ctl, d.help ? loc(d.help) : undefined, longOpts));
        }
      return h('section.card.rule-group-card', { class: open ? 'open' : '' }, head, body);
    });

    rulesWrap.replaceChildren(
      h(
        'section.card.set-card.preset-card',
        h('div.rsel-line', ruleSelect(
          // every mode's rule sets in one list (no separate mode switch): another mode's set opens that mode
          MODES.flatMap((m): RuleSelectItem[] => {
            if (m === rmode)
              return [
                { label: loc(preset.label), on: isPreset, pick: restore },
                ...mine.map((p) => ({ label: p.name, on: p === active, pick: () => applyProfile(p) })),
                ...(!isPreset && !active ? [{ label: t('settings.preset.custom'), on: true, custom: true }] : []),
              ];
            const pm = o.presets.find((p) => p.id === m);
            return [
              ...(pm ? [{ label: loc(pm.label), on: false, pick: () => openMode(m, pm.rules) }] : []),
              ...loadProfiles().filter((p) => p.mode === m).map((p) => ({ label: p.name, on: false, pick: () => openMode(m, p.rules) })),
            ];
          }),
          t('settings.preset'),
        ), profileAct),
        profileCtl,
      ),
      ...groupEls,
    );
  };
  renderRules();

  // ── tabs ──
  // rules are chosen when starting a game: no Reglas tab inside one
  const TABS: SettingsTab[] = o.matchInProgress ? ['game', 'av'] : ALL_TABS;
  let tab: SettingsTab = o.rulesMode && !o.matchInProgress ? 'rules' : TABS.includes(s.settingsTab as SettingsTab) ? (s.settingsTab as SettingsTab) : 'game';
  const panel = h('div.content.set-panel', { role: 'tabpanel' });
  const scroll = h('div.scroll.set-scroll', panel);
  const tabBtns = TABS.map((k) => {
    const b = h(
      'button.set-tab',
      { type: 'button', role: 'tab', id: `set-tab-${k}`, 'aria-selected': String(k === tab), tabindex: k === tab ? 0 : -1 },
      h('span.set-tab-icon', { html: TAB_ICONS[k] }),
      h('span.set-tab-label', t(`settings.tab.${k}` as Key)),
    );
    b.addEventListener('click', () => show(k, true));
    b.addEventListener('keydown', (e) => {
      const i = TABS.indexOf(k);
      const n = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!n) return;
      e.preventDefault();
      const next = TABS[(i + n + TABS.length) % TABS.length];
      show(next, true);
      tabBtns[TABS.indexOf(next)].focus();
    });
    return b;
  });
  const show = (k: SettingsTab, user: boolean) => {
    tab = k;
    tabBtns.forEach((b, i) => {
      b.setAttribute('aria-selected', String(TABS[i] === k));
      b.tabIndex = TABS[i] === k ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', `set-tab-${k}`);
    panel.replaceChildren(k === 'game' ? tabGame() : k === 'rules' ? rulesWrap : tabAv());
    scroll.scrollTop = 0;
    if (user && s.settingsTab !== k) set('settingsTab', k);
  };
  show(tab, false);

  return h(
    'section.screen.panel-screen.settings',
    screenHeader(t('settings.title'), () => {
      if (name.value.trim() !== s.playerName) set('playerName', name.value.trim().slice(0, 14));
      o.onBack();
    }),
    h('div.set-layout', h('nav.set-tabs', { role: 'tablist', 'aria-label': t('settings.tabs') }, ...tabBtns), scroll),
  );
}
