import { describe, expect, it, vi } from 'vitest';
import type { Card, CardKind, GameEvent } from '../contracts';
import { cancelVoice, drawPhrase, phraseFor, setVoiceHook, voiceForEvent } from './voice';

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

  it('calls out a multi-play once, on its last card', () => {
    const multi = (kind: CardKind, more: boolean, id = 1): GameEvent => ({ type: 'play', seat: 0, more, card: { id, face: { kind, color: 'sol' } } as Card });
    for (const kind of ['skip', 'reverse'] as CardKind[]) {
      expect(phraseFor(multi(kind, true))).toBeNull();
      expect(phraseFor(multi(kind, false))).toBe(kind === 'skip' ? 'Skip!' : 'Reverse!');
    }
    // intermediate and final cards of a longer run: still only one callout
    expect(phraseFor(multi('skip', true, 2))).toBeNull();
    expect(phraseFor(multi('skip', true, 3))).toBeNull();
    expect(phraseFor(multi('skip', false, 4))).toBe('Skip!');
  });

  it('cancels delayed callouts when the game is left', () => {
    vi.useFakeTimers();
    let spoken = 0;
    setVoiceHook(() => spoken++);
    try {
      voiceForEvent(play('skip'), 140);
      cancelVoice();
      vi.advanceTimersByTime(500);
      expect(spoken).toBe(0);
    } finally {
      setVoiceHook(null);
      vi.useRealTimers();
    }
  });
});
