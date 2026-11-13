import type { Card } from '../shared/cards.ts';

const SUIT: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const SUIT_NAME: Record<string, string> = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
const RANK_NAME: Record<string, string> = {
  A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: '10',
};

export function cardLabel(c: Card) {
  return `${RANK_NAME[c[0]] ?? c[0]} of ${SUIT_NAME[c[1]]}`;
}

export function PlayingCard({
  card,
  size = 'md',
  dim = false,
  highlight = false,
  className = '',
}: {
  card: Card | null;
  size?: 'sm' | 'md' | 'lg';
  dim?: boolean;
  highlight?: boolean;
  className?: string;
}) {
  if (!card) return <div className={`card back ${size} ${className}`} aria-label="Face-down card" />;
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = card[1];
  return (
    <div
      className={`card face ${size} suit-${suit} ${dim ? 'dim' : ''} ${highlight ? 'hl' : ''} ${className}`}
      aria-label={cardLabel(card)}
      role="img"
    >
      <span className="rank">{rank}</span>
      <span className="suit">{SUIT[suit]}</span>
      <span className="pip" aria-hidden>
        {SUIT[suit]}
      </span>
    </div>
  );
}

/** A card that turns face-up when it mounts (the back shows first, then it flips). Sized by `--tc` in the tabled hands. */
export function FlipCard({ card, highlight = false }: { card: Card; highlight?: boolean }) {
  return (
    <div className="flip-slot">
      <div className="flip">
        <PlayingCard card={card} size="sm" highlight={highlight} />
        <div className="card back sm" aria-hidden />
      </div>
    </div>
  );
}

export function EmptySlot({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return <div className={`card slot ${size}`} aria-hidden />;
}
