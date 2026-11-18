/**
 * Ajustes: three tabs (Juego · Reglas · Imagen y sonido), ported from Kudominoes. The rule list is
 * rendered generically from the engine's RULE_SETTINGS descriptors, filtered by mode and grouped by
 * `group`, so new variants need no UI work.
 */
import type { AppSettings, CardBack, GameMode, RulePreset, RuleSettings, SettingDescriptor, SettingValue, TableStyle } from '../contracts';
import { CARD_BACKS, TABLE_STYLES } from '../contracts';
import { createAvatarEditor, type FaceSpec } from 'kuavatars';
import { cardBackSvg, tableSwatchSvg } from './cardArt';
import { h } from './dom';
import { screenHeader } from './howto';
import { enhanceHScroll } from './hscroll';
import { loc, t, tMaybe, type Key } from './i18n';
import { ICONS, segmented, toggle } from './overlay';

export type SettingsTab = 'game' | 'rules' | 'av';
const TABS: SettingsTab[] = ['game', 'rules', 'av'];
const MODES: GameMode[] = ['classic', 'action', 'cyclone', 'partners'];

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

/** a settings row; `help` sits behind a small ⓘ button */
function row(label: string, control: Node, help?: string, stack = false): HTMLElement {
  const helpId = `set-help-${++rowSeq}`;
  const helpEl = help ? h('div.set-help', { id: helpId, hidden: true }, help) : null;
  let info: HTMLButtonElement | null = null;
  if (help) {
    info = h('button.info-btn', { type: 'button', 'aria-expanded': 'false', 'aria-controls': helpId, 'aria-label': `${t('settings.info')}: ${label}`, title: t('settings.info') }, 'i');
    info.addEventListener('click', () => {
      const open = info!.getAttribute('aria-expanded') !== 'true';
      info!.setAttribute('aria-expanded', String(open));
      helpEl!.hidden = !open;
    });
  }
  return h('div.set-row', { class: stack ? 'stack' : '' }, h('div.set-text', h('div.set-label-line', h('span.set-label', label), info), helpEl), h('div.set-ctl', control));
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

function sameAs(rules: RuleSettings, preset: RuleSettings, descriptors: SettingDescriptor[]): boolean {
  return descriptors.every((d) => (rules[d.key] ?? d.default) === (preset[d.key] ?? d.default));
}

/** name of the mode's preset when the rules match it, else "Personalizado" */
export function presetName(presets: RulePreset[], descriptors: SettingDescriptor[], rules: RuleSettings, mode: GameMode): string {
  const p = presets.find((x) => x.id === mode);
  return p && sameAs(rules, p.rules, descriptorsForMode(descriptors, mode)) ? loc(p.label) : t('settings.preset.custom');
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
      h(
        'section.card.set-card',
        row(t('settings.name'), name),
        row(t('settings.avatarFace'), faceEditor(s.avatarFace ?? 0, (v) => set('avatarFace', v)), undefined, true),
      ),
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
        row(t('settings.music'), toggle(s.music, (v) => set('music', v), t('settings.music'))),
        'vibrate' in navigator ? row(t('settings.vibration'), toggle(s.vibration, (v) => set('vibration', v), t('settings.vibration'))) : null,
      ),
    );

  // ── Reglas: mode selector + preset chip + collapsible groups ──
  let openGroup: string | null = null;
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
    const chip = (label: string, on: boolean, onClick?: () => void) => {
      const b = h('button.preset-chip', { type: 'button', 'aria-pressed': String(on), disabled: !onClick && !on ? true : undefined }, label);
      if (onClick) b.addEventListener('click', onClick);
      return b;
    };
    const restore = async () => {
      if (isPreset) return;
      if (o.matchInProgress) {
        const ok = await o.confirm({
          title: t('settings.presetConfirmTitle', { name: loc(preset.label) }),
          body: t('settings.presetConfirmBody'),
          ok: t('settings.presetConfirmOk'),
          cancel: t('common.cancel'),
        });
        if (!ok) return;
      }
      store({ ...preset.rules });
      renderRules();
    };
    const modeSwitch = segmented<GameMode>(
      MODES.map((m) => ({ value: m, label: t(`mode.${m}` as Key) })),
      rmode,
      (v) => {
        rmode = v;
        openGroup = null;
        renderRules();
      },
      t('settings.rulesMode'),
    );
    modeSwitch.classList.add('seg-rules-mode');

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
          const ctl =
            d.type === 'toggle'
              ? toggle(Boolean(val), (v) => setRule(d.key, v), loc(d.label))
              : segmented(
                  (d.options ?? []).map((op) => ({ value: op.value, label: optionLabel(op) })),
                  val,
                  (v) => setRule(d.key, v),
                  loc(d.label),
                );
          const longOpts = d.type === 'select' && ((d.options?.length ?? 0) > 2 || (d.options ?? []).some((op) => optionLabel(op).length > 9));
          body.append(row(loc(d.label), ctl, d.help ? loc(d.help) : undefined, longOpts));
        }
      return h('section.card.rule-group-card', { class: open ? 'open' : '' }, head, body);
    });

    rulesWrap.replaceChildren(
      h(
        'section.card.set-card.preset-card',
        modeSwitch,
        h('p.set-help.lead', `${loc(preset.blurb)} ${t('settings.rulesNext')}`),
        h('div.presets', { role: 'group', 'aria-label': t('settings.preset') }, chip(loc(preset.label), isPreset, isPreset ? undefined : () => void restore()), chip(t('settings.preset.custom'), !isPreset)),
        o.matchInProgress ? h('p.warn', { role: 'note' }, t('settings.rulesWarn')) : null,
      ),
      ...groupEls,
    );
  };
  renderRules();

  // ── tabs ──
  let tab: SettingsTab = o.rulesMode ? 'rules' : TABS.includes(s.settingsTab as SettingsTab) ? (s.settingsTab as SettingsTab) : 'game';
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
