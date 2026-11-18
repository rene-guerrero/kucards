import type { GameMode, RulePreset, RuleSettings, SettingDescriptor } from '../contracts';

export const RULES_VERSION = 1;

const on = { value: true, label: { es: 'Sí', en: 'On' } };
const off = { value: false, label: { es: 'No', en: 'Off' } };

/** Every rule the settings screen shows (PLAN.md §4). Rendered generically from these descriptors. */
export const RULE_SETTINGS: SettingDescriptor[] = [
  {
    key: 'handSize', group: 'match', type: 'select', default: 7,
    label: { es: 'Cartas por jugador', en: 'Cards per player' },
    options: [5, 7, 10].map((n) => ({ value: n, label: { es: String(n), en: String(n) } })),
  },
  {
    key: 'target', group: 'match', type: 'select', default: 500,
    label: { es: 'Meta de la partida', en: 'Match target' },
    options: [
      { value: 0, label: { es: 'Una ronda', en: 'One round' } },
      { value: 200, label: { es: '200 puntos', en: '200 points' } },
      { value: 500, label: { es: '500 puntos', en: '500 points' } },
    ],
  },
  {
    key: 'drawMode', group: 'turn', type: 'select', default: 'one',
    label: { es: 'Al no poder jugar', en: 'When you cannot play' },
    options: [
      { value: 'one', label: { es: 'Robar una', en: 'Draw one' } },
      { value: 'untilPlayable', label: { es: 'Robar hasta poder jugar', en: 'Draw until playable' } },
    ],
  },
  {
    key: 'forcePlay', group: 'turn', type: 'toggle', default: false,
    label: { es: 'Jugar la carta robada', en: 'Must play the drawn card' },
    help: { es: 'Si la carta que robas se puede jugar, debes jugarla.', en: 'If the card you draw can be played, you must play it.' },
    options: [on, off],
  },
  {
    key: 'jumpIn', group: 'turn', type: 'toggle', default: false,
    label: { es: 'Entrar sin turno', en: 'Jump in' },
    help: { es: 'Puedes jugar una carta idéntica a la de la pila aunque no sea tu turno.', en: 'Play an identical card out of turn.' },
    options: [on, off],
  },
  {
    key: 'sevenZero', group: 'turn', type: 'toggle', default: false,
    label: { es: '7 cambia, 0 rota', en: '7 swaps, 0 rotates' },
    help: { es: 'Con un 7 cambias tu mano con otro jugador; con un 0 todos pasan su mano al siguiente.', en: 'A 7 swaps hands with a player; a 0 passes every hand along.' },
    options: [on, off],
  },
  {
    key: 'kuCall', group: 'turn', type: 'toggle', default: true,
    label: { es: 'Gritar ¡Ku!', en: 'Call ¡Ku!' },
    help: { es: 'Al quedarte con una carta debes gritar ¡Ku!; si te descubren, robas 2.', en: 'Call ¡Ku! on your last card or draw 2 if caught.' },
    options: [on, off],
  },
  {
    key: 'stacking', group: 'penalties', type: 'select', default: 'off',
    label: { es: 'Acumular castigos', en: 'Stack penalties' },
    options: [
      { value: 'off', label: { es: 'No', en: 'Off' } },
      { value: 'same', label: { es: 'Solo la misma carta', en: 'Same card only' } },
      { value: 'any', label: { es: '+2 y +4 libremente', en: '+2 and +4 freely' } },
    ],
  },
  {
    key: 'wild4Challenge', group: 'penalties', type: 'toggle', default: false,
    label: { es: 'Desafiar el +4', en: 'Challenge +4' },
    help: { es: 'Puedes desafiar un +4 (o +10): si quien lo jugó tenía el color activo, roba él; si no, robas 2 más.', en: 'Challenge a +4 (or +10): if its player held the active colour they draw it; if not, you draw 2 extra.' },
    options: [on, off],
  },
  {
    key: 'eliminateAt', group: 'penalties', type: 'select', default: 0,
    label: { es: 'Eliminación', en: 'Elimination' },
    help: { es: 'Quien acumule esa cantidad de cartas queda fuera.', en: 'A player holding that many cards is out.' },
    options: [
      { value: 0, label: { es: 'No', en: 'Off' } },
      { value: 25, label: { es: '25 cartas', en: '25 cards' } },
      { value: 30, label: { es: '30 cartas', en: '30 cards' } },
    ],
  },
  { key: 'power.swap', group: 'power', type: 'toggle', default: false, label: { es: 'Cambio', en: 'Swap' }, help: { es: 'Comodín: cambias tu mano con otro jugador.', en: 'Wild: swap hands with another player.' }, options: [on, off] },
  { key: 'power.shield', group: 'power', type: 'toggle', default: false, label: { es: 'Escudo', en: 'Shield' }, help: { es: 'Anula un castigo de robar, incluso fuera de turno.', en: 'Blocks a draw penalty, even out of turn.' }, options: [on, off] },
  { key: 'power.sweep', group: 'power', type: 'toggle', default: false, label: { es: 'Barrida', en: 'Sweep' }, help: { es: 'Descartas todas tus cartas de ese color.', en: 'Discard all your cards of that colour.' }, options: [on, off] },
  { key: 'power.mirror', group: 'power', type: 'toggle', default: false, label: { es: 'Espejo', en: 'Mirror' }, help: { es: 'Devuelve el castigo a quien lo jugó.', en: 'Bounces a penalty back to who played it.' }, options: [on, off] },
  {
    key: 'seating', group: 'partners', type: 'select', default: 'across', modes: ['partners'],
    label: { es: 'Asientos', en: 'Seating' },
    options: [
      { value: 'across', label: { es: 'Enfrente', en: 'Across' } },
      { value: 'side', label: { es: 'Codo a codo', en: 'Side by side' } },
    ],
  },
  { key: 'partnerOpen', group: 'partners', type: 'toggle', default: true, modes: ['partners'], label: { es: 'Cartas del compañero a la vista', en: 'Partner cards face up' }, help: { es: 'Ves las cartas de tu compañero y él ve las tuyas.', en: 'You see your partner’s cards and they see yours.' }, options: [on, off] },
  { key: 'partnerShield', group: 'partners', type: 'toggle', default: false, modes: ['partners'], label: { es: 'Escudo para el compañero', en: 'Shield your partner' }, help: { es: 'Puedes jugar un Escudo para librar a tu compañero de un castigo.', en: 'Play a Shield to save your partner from a penalty.' }, options: [on, off] },
  { key: 'partnerPass', group: 'partners', type: 'toggle', default: false, modes: ['partners'], label: { es: 'Pasar carta al compañero', en: 'Pass a card to your partner' }, help: { es: 'Con un 7 puedes darle una carta a tu compañero.', en: 'On a 7 you may give one card to your partner.' }, options: [on, off] },
];

/** 'deck' is set by presets only ('classic' | 'action' | 'cyclone'), not shown in settings */
export const DEFAULT_RULES: RuleSettings = { deck: 'classic', ...Object.fromEntries(RULE_SETTINGS.map((d) => [d.key, d.default])) };

const preset = (id: GameMode, label: RulePreset['label'], blurb: RulePreset['blurb'], over: RuleSettings): RulePreset => ({
  id, label, blurb, rules: { ...DEFAULT_RULES, ...over },
});

export const RULE_PRESETS: RulePreset[] = [
  preset('classic', { es: 'Clásico', en: 'Classic' }, { es: 'Combina color o número. Sin sorpresas.', en: 'Match colour or number. No surprises.' }, {}),
  preset('action', { es: 'Pura acción', en: 'All Action' }, { es: 'Más cartas especiales y todos los poderes.', en: 'More action cards and every power card.' }, {
    deck: 'action', 'power.swap': true, 'power.shield': true, 'power.sweep': true, 'power.mirror': true,
  }),
  preset('cyclone', { es: 'Ciclón', en: 'Cyclone' }, { es: 'Castigos que se acumulan. Con 25 cartas, quedas fuera.', en: 'Stacking penalties. Hold 25 cards and you are out.' }, {
    deck: 'cyclone', stacking: 'any', eliminateAt: 25, drawMode: 'untilPlayable', target: 0,
  }),
  preset('partners', { es: 'Parejas', en: 'Partners' }, { es: 'Dos contra dos. Gana la pareja que se vacíe primero.', en: 'Two against two. First pair to empty a hand wins.' }, {}),
];
