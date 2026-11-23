import type { GameMode, RulePreset, RuleSettings, SettingDescriptor } from '../contracts';
import { applyForced, modeDef, upgradeLegacyRules } from './modes';

export { upgradeLegacyRules };

export const RULES_VERSION = 1;

const on = { value: true, label: { es: 'Sí', en: 'On' } };
const off = { value: false, label: { es: 'No', en: 'Off' } };

/** Every rule the settings screen shows (PLAN.md §4). Rendered generically from these descriptors. */
export const RULE_SETTINGS: SettingDescriptor[] = [
  {
    key: 'handSize', group: 'match', type: 'select', default: 7,
    label: { es: 'Cartas por jugador', en: 'Cards per player' },
    help: { es: 'Cuántas cartas recibe cada jugador al repartir.', en: 'How many cards each player is dealt.' },
    options: [5, 7, 10].map((n) => ({ value: n, label: { es: String(n), en: String(n) } })),
  },
  {
    key: 'target', group: 'match', type: 'select', default: 500,
    label: { es: 'Meta de la partida', en: 'Match target' },
    help: { es: 'La partida termina cuando alguien llega a estos puntos. Gana el primero en llegar.', en: 'The match ends when someone reaches this score. The first to reach it wins.' },
    options: [
      { value: 0, label: { es: 'Una ronda', en: 'One round' } },
      { value: 200, label: { es: '200 puntos', en: '200 points' } },
      { value: 500, label: { es: '500 puntos', en: '500 points' } },
    ],
  },
  {
    key: 'drawMode', group: 'turn', type: 'select', default: 'one',
    label: { es: 'Al no poder jugar', en: 'If you can’t play' },
    help: { es: 'Si no tienes carta que sirva: robas una, o robas hasta encontrar una que puedas jugar.', en: 'If you have no playable card: draw one, or keep drawing until you get one you can play.' },
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
    help: { es: 'Puedes jugar una carta idéntica a la de la pila aunque no sea tu turno.', en: 'You can play a card identical to the top of the pile even when it isn’t your turn.' },
    options: [on, off],
  },
  {
    key: 'sevenSwap', group: 'turn', type: 'toggle', default: false,
    label: { es: 'El 7 cambia manos', en: 'Sevens swap hands' },
    short: { es: '7 cambia', en: '7 swaps' },
    help: { es: 'Al jugar un 7 eliges a otro jugador y cambias tu mano con la suya.', en: 'When you play a 7, you pick another player and swap hands with them.' },
    options: [on, off],
  },
  {
    key: 'zeroPass', group: 'turn', type: 'toggle', default: false,
    label: { es: 'El 0 pasa las manos', en: 'Zeros pass hands' },
    short: { es: '0 pasa', en: '0 passes' },
    help: { es: 'Al jugar un 0, todos pasan su mano entera al siguiente jugador en el sentido del juego.', en: 'When a 0 is played, everyone passes their whole hand to the next player in the direction of play.' },
    options: [on, off],
  },
  {
    key: 'multiPlay', group: 'turn', type: 'toggle', default: false,
    label: { es: 'Jugar varias del mismo número', en: 'Play matching numbers together' },
    help: { es: 'Si la primera se puede jugar, puedes jugar a la vez otras cartas con el mismo número; la última que elijas marca el color.', en: 'If the first card is playable, you can play other cards with the same number along with it; the last one you pick sets the color.' },
    options: [on, off],
  },
  {
    key: 'multiDraw2', group: 'turn', type: 'toggle', default: false,
    label: { es: 'Varios +2 a la vez', en: 'Several +2s at once' },
    help: { es: 'Si el primero se puede jugar, puedes soltar a la vez otros +2 de cualquier color: cada uno suma 2 (tres +2 son +6). El siguiente aún puede acumular si se permite.', en: 'If the first one is playable, you can play other +2s of any color along with it: each adds 2 (three +2s make +6). The next player can still stack if allowed.' },
    options: [on, off],
  },
  {
    key: 'multiReverse', group: 'turn', type: 'toggle', default: false,
    label: { es: 'Varias Vueltas a la vez', en: 'Several Reverses at once' },
    help: { es: 'Si la primera se puede jugar, puedes soltar a la vez otras Vueltas de cualquier color: cada una cambia el sentido (dos lo dejan igual). Entre dos jugadores cada una salta al otro.', en: 'If the first one is playable, you can play other Reverses of any color along with it: each flips the direction (two cancel out). With two players, each one skips the other player.' },
    options: [on, off],
  },
  {
    key: 'multiSkip', group: 'turn', type: 'toggle', default: false,
    label: { es: 'Varios Saltos a la vez', en: 'Several Skips at once' },
    help: { es: 'Si el primero se puede jugar, puedes soltar a la vez otros Saltos de cualquier color: cada uno salta a un jugador más, dando la vuelta a la mesa.', en: 'If the first one is playable, you can play other Skips of any color along with it: each one skips one more player, going around the table.' },
    options: [on, off],
  },
  {
    key: 'numberFinish', group: 'match', type: 'toggle', default: false,
    label: { es: 'Ganar solo con números', en: 'Finish on a number' },
    help: { es: 'No puedes ganar con una carta especial: tu última carta debe ser un número.', en: 'You can’t win with a special card: your last card must be a number.' },
    options: [on, off],
  },
  {
    key: 'kuCall', group: 'turn', type: 'toggle', default: true,
    label: { es: 'Gritar ¡Ku!', en: 'Call ¡Ku!' },
    help: { es: 'Al quedarte con una carta debes gritar ¡Ku!; si te descubren, robas 2.', en: 'When you’re down to one card, call ¡Ku!; if you get caught, you draw 2.' },
    options: [on, off],
  },
  {
    // only Clásico may turn it off; every other mode always stacks +2 / +4 freely (modeRules)
    key: 'stacking', group: 'penalties', type: 'select', default: 'off', modes: ['classic'],
    label: { es: 'Acumular castigos', en: 'Stack penalties' },
    help: { es: 'Si te lanzan un +2 o +4, puedes responder con otro y pasar la suma al siguiente.', en: 'When you’re hit with a +2 or +4, you can answer with another and pass the total to the next player.' },
    options: [
      { value: 'off', label: { es: 'No', en: 'Off' } },
      { value: 'same', label: { es: 'Solo la misma carta', en: 'Same card only' } },
      { value: 'any', label: { es: '+2 y +4 libremente', en: '+2 and +4 freely' } },
    ],
  },
  {
    key: 'eliminateAt', group: 'penalties', type: 'select', default: 0,
    label: { es: 'Eliminación', en: 'Elimination' },
    help: { es: 'Quien acumule esa cantidad de cartas queda fuera.', en: 'Anyone who ends up holding that many cards is out.' },
    options: [
      { value: 0, label: { es: 'No', en: 'Off' } },
      { value: 25, label: { es: '25 cartas', en: '25 cards' } },
      { value: 30, label: { es: '30 cartas', en: '30 cards' } },
    ],
  },
  { key: 'power.swap', group: 'power', type: 'toggle', default: false, modes: ['classic', 'cyclone', 'sideBySide'], label: { es: 'Cambio', en: 'Swap' }, help: { es: 'Comodín: cambias tu mano con otro jugador.', en: 'Wild: swap hands with another player.' }, options: [on, off] },
  { key: 'power.sweep', group: 'power', type: 'toggle', default: false, modes: ['classic', 'cyclone'], label: { es: 'Barrida', en: 'Sweep' }, help: { es: 'Descartas todas tus cartas de ese color.', en: 'Discard all your cards of that color.' }, options: [on, off] },
  // Escudo (power.shield), Espejo (power.mirror) and partnerShield have no descriptor, preset or default
  // deck, but player-made modes can still put their cards in a deck. The engine, renderer and network
  // mirror keep supporting them; sanitizeRules/normalizeRules only drop the obsolete rule toggles.
  { key: 'partnerOpen', group: 'partners', type: 'toggle', default: true, label: { es: 'Cartas del compañero a la vista', en: 'Partner’s cards face up' }, help: { es: 'Ves las cartas de tu compañero y él ve las tuyas.', en: 'You see your partner’s cards and they see yours.' }, options: [on, off] },
  { key: 'partnerPass', group: 'partners', type: 'toggle', default: false, label: { es: 'Pasar carta al compañero', en: 'Pass a card to your partner' }, help: { es: 'Con un 7 puedes darle una carta a tu compañero.', en: 'When you play a 7, you can give one card to your partner.' }, options: [on, off] },
];

/**
 * 'deck' is set by presets only, not shown in settings. Deck composition per mode (buildDeck):
 *  - Clásico ('classic', 108): per colour one 0, two of 1–9, two Salto / Vuelta / +2; 4 Comodín, 4 +4.
 *    Optional in Reglas: Cambio ×2, Barrida ×1 per colour. No stacking unless turned on.
 *  - Pura acción ('action', 106): per colour 0 and two of 5–9, four Salto / Vuelta / +2, one Barrida;
 *    4 Comodín, 4 +4, 2 Cambio. Stacking always on.
 *  - Ciclón ('cyclone', 128): Clásico plus per colour two Barrida (on by default, can be turned off) and
 *    one +6; 6 +10 and 2 more +4 (6 in all). Optional Cambio. Stacking always on, out at 25 cards.
 *  - Codo a codo ('sideBySide', 120): Clásico plus per colour two Barrida and one +6; optional Cambio.
 *    Stacking always on.
 *  - Día y Noche ('dayNight', 112 two-sided cards): Día = Clásico plus one Eclipse per colour; Noche =
 *    four night colours with +5, Vuelta, Salto total and Eclipse, 4 Comodín and 4 Comodín +6
 *    (cards.ts dayFaces / nightFaces). No power cards. Stacking always on.
 * Salto total (skipAll), Escudo and Espejo are in no other deck; «roba hasta el color» (wildColor) is in
 * no deck at all (the engine still handles them).
 */
export const DEFAULT_RULES: RuleSettings = { deck: 'classic', ...Object.fromEntries(RULE_SETTINGS.map((d) => [d.key, d.default])) };

const preset = (id: GameMode, label: RulePreset['label'], blurb: RulePreset['blurb'], over: RuleSettings): RulePreset => ({
  id, label, blurb, rules: { ...DEFAULT_RULES, ...over },
});

export const RULE_PRESETS: RulePreset[] = [
  preset('classic', { es: 'Clásico', en: 'Classic' }, { es: 'Combina color o número. Sin sorpresas.', en: 'Match color or number. No surprises.' }, {}),
  preset('action', { es: 'Pura acción', en: 'All Action' }, { es: 'Más cartas especiales, Barrida y Cambio.', en: 'More action cards, Sweep and Swap.' }, {
    deck: 'action', stacking: 'any', 'power.swap': true, 'power.sweep': true,
  }),
  preset('cyclone', { es: 'Ciclón', en: 'Cyclone' }, { es: 'Castigos que se acumulan. Con 25 cartas, quedas fuera.', en: 'Penalties stack. Reach 25 cards and you’re out.' }, {
    deck: 'cyclone', stacking: 'any', 'power.sweep': true, eliminateAt: 25, drawMode: 'untilPlayable', target: 0, sevenSwap: true, zeroPass: true,
  }),
  preset('sideBySide', { es: 'Codo a codo', en: 'Side by Side' }, { es: '2 vs 2, tu pareja al lado. Los castigos se acumulan.', en: '2 vs 2, with your partner beside you. Penalties stack.' }, {
    deck: 'sideBySide', stacking: 'any', 'power.sweep': true,
  }),
  preset('dayNight', { es: 'Día y Noche', en: 'Day & Night' }, { es: 'Cartas de dos caras: el Eclipse voltea el juego a la Noche.', en: 'Two-sided cards: the Eclipse flips the game to Night.' }, {
    deck: 'dayNight', stacking: 'any',
  }),
];

/** a 7 swaps hands with a chosen player (`sevenSwap`; the older combined `sevenZero` turns it on too) */
export const sevenSwapOn = (rules: RuleSettings): boolean => !!(rules.sevenSwap || rules.sevenZero);
/** a 0 passes every hand along in play direction (`zeroPass`; the older combined `sevenZero` turns it on too) */
export const zeroPassOn = (rules: RuleSettings): boolean => !!(rules.zeroPass || rules.sevenZero);

/**
 * rules a mode always enforces: every mode but Clásico stacks +2 / +4 freely; Pura acción always has
 * Barrida and Cambio, Codo a codo always has Barrida.
 */
export function modeRules(mode: GameMode, rules: RuleSettings): RuleSettings {
  // what each mode enforces lives in its definition (modes.ts: BUILTIN_MODES[...].forced)
  return applyForced(modeDef(mode), rules);
}
