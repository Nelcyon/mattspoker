import { useEffect } from 'react';
import { PlayingCard } from './Card.tsx';

// Best hand first. `n` = how many of the five cards make the hand (the rest are shown dimmed).
const HANDS: { name: string; words: string; cards: string[]; n: number }[] = [
  { name: 'Royal flush', words: '10 to Ace, same suit', cards: ['As', 'Ks', 'Qs', 'Js', 'Ts'], n: 5 },
  { name: 'Straight flush', words: 'Five in a row, same suit', cards: ['9h', '8h', '7h', '6h', '5h'], n: 5 },
  { name: 'Four of a kind', words: 'Four cards, same number', cards: ['9s', '9h', '9d', '9c', 'Kd'], n: 4 },
  { name: 'Full house', words: 'Three plus a pair', cards: ['Qs', 'Qh', 'Qd', '4c', '4s'], n: 5 },
  { name: 'Flush', words: 'Five of the same suit', cards: ['Ah', 'Jh', '8h', '5h', '3h'], n: 5 },
  { name: 'Straight', words: 'Five in a row', cards: ['9c', '8d', '7h', '6s', '5d'], n: 5 },
  { name: 'Three of a kind', words: 'Three, same number', cards: ['7s', '7h', '7d', 'Kc', '2s'], n: 3 },
  { name: 'Two pair', words: 'Two different pairs', cards: ['Js', 'Jd', '4h', '4c', 'Ad'], n: 4 },
  { name: 'Pair', words: 'Two, same number', cards: ['Ts', 'Td', 'Ah', '7c', '3d'], n: 2 },
  { name: 'High card', words: 'No match: highest card', cards: ['Ad', 'Jc', '8h', '5s', '2d'], n: 1 },
];

export function HelpCard({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet help" role="dialog" aria-label="Hand rankings" onClick={onClose}>
        <div className="sheet-head">
          <h2>Best hand to worst</h2>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
        <ol className="help-list">
          {HANDS.map((h, i) => (
            <li key={h.name} className="help-row">
              <div className="help-text">
                <b>
                  <span className="help-n">{i + 1}</span> {h.name}
                </b>
                <span>{h.words}</span>
              </div>
              <div className="help-cards">
                {h.cards.map((c, j) => (
                  <PlayingCard key={c} card={c} size="sm" dim={j >= h.n} />
                ))}
              </div>
            </li>
          ))}
        </ol>
        <p className="help-foot">Best five cards from your two plus the five on the table.</p>
      </div>
    </div>
  );
}
