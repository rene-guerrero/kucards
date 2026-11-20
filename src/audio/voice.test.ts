import { describe, expect, it } from 'vitest';
import type { Card, CardKind, GameEvent } from '../contracts';
import { drawPhrase, phraseFor } from './voice';

const play = (kind: CardKind, draw?: number): GameEvent => ({ type: 'play', seat: 0, card: { id: 1, face: { kind, color: 'sol', draw } } as Card });

describe('voice phrases', () => {
  it('speaks draws only when drawn; skip, reverse and colours on play', () => {
    const draw = (count: number, reason: 'penalty' | 'turn'): GameEvent => ({ type: 'draw', seat: 1, count, reason });
    expect(phraseFor(draw(2, 'penalty'))).toBe('Draw two!');
    expect(phraseFor(draw(14, 'penalty'))).toBe('Draw cards!');
    expect(phraseFor(draw(1, 'turn'))).toBeNull();
    expect(drawPhrase(31)).toBe('Draw cards!');
    expect(drawPhrase(6)).toBe('Draw six!');
    expect(drawPhrase(8)).toBe('Draw cards!');
    expect(phraseFor(play('draw2', 2))).toBeNull();
    expect(phraseFor({ type: 'stack', total: 8 })).toBeNull();
    expect(phraseFor(play('skip'))).toBe('Skip!');
    expect(phraseFor(play('reverse'))).toBe('Reverse!');
    const wild = (kind: CardKind, color: 'coral' | 'mar'): GameEvent => ({ type: 'play', seat: 0, color, card: { id: 2, face: { kind, color: null } } as Card });
    expect(phraseFor(wild('wild', 'coral'))).toBe('Red!');
    expect(phraseFor(wild('wild4', 'mar'))).toBe('Blue!');
    expect(phraseFor(play('number'))).toBeNull();
  });
});
