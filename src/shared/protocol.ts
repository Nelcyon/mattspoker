// Messages between the app and the server, and the table as each player sees it.
import type { Card } from './cards.ts';
import type { Street } from './holdem.ts';

export interface Settings {
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
  /** Seconds a player has to act. 0 = no clock (players away from the game still get auto-checked/folded). */
  turnSeconds: number;
  /** Minutes between blind increases. 0 = blinds stay the same. */
  blindLevelMinutes: number;
  /** Players who run out of chips may buy back in for the starting stack. */
  allowRebuys: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  startingStack: 1000,
  smallBlind: 5,
  bigBlind: 10,
  turnSeconds: 0,
  blindLevelMinutes: 0,
  allowRebuys: true,
};

export const MAX_SEATS = 10;
/** Blind multipliers per level when blinds go up. */
export const BLIND_LEVELS = [1, 2, 3, 4, 6, 8, 10, 15, 20, 30, 40, 50, 60, 80, 100, 150, 200];
export const TURN_SECONDS_OPTIONS = [0, 20, 30, 45, 60, 90, 120];
export const BLIND_MINUTES_OPTIONS = [0, 10, 15, 20, 30, 45, 60];
/** How long someone who is offline or has the game hidden gets before they are checked or folded automatically. */
export const AWAY_GRACE_SECONDS = 30;
export const QUICK_REACTIONS = ['👍', '😂', '😮', '🔥', '😭', '🎉', 'Nice hand!', 'Good game', 'Ouch', 'Hurry up 😄'];

export type ClientMsg =
  | { t: 'join'; name: string; token?: string; takeover?: boolean }
  | { t: 'act'; handId: number; action: 'fold' | 'check' | 'call' | 'raise'; to?: number }
  | { t: 'sitOut' }
  | { t: 'sitIn' }
  | { t: 'rebuy' }
  | { t: 'sit'; seat: number }
  | { t: 'leave' }
  | { t: 'show' }
  | { t: 'react'; text: string }
  | { t: 'visibility'; hidden: boolean }
  | { t: 'claimHost' }
  | { t: 'host'; op: 'start' }
  | { t: 'host'; op: 'pause' }
  | { t: 'host'; op: 'resume' }
  | { t: 'host'; op: 'settings'; settings: Partial<Settings> }
  | { t: 'host'; op: 'setStack'; pid: string; stack: number }
  | { t: 'host'; op: 'remove'; pid: string }
  | { t: 'host'; op: 'makeHost'; pid: string }
  | { t: 'host'; op: 'clock'; pid: string }
  | { t: 'host'; op: 'moveSeat'; pid: string; seat: number };

export type ServerMsg =
  | { t: 'welcome'; pid: string; token: string; code: string }
  | { t: 'state'; s: TableView }
  | { t: 'error'; message: string; fatal?: 'noGame' | 'badName' }
  | { t: 'takeoverPrompt'; name: string }
  | { t: 'replaced' }
  | { t: 'removed' }
  | { t: 'reaction'; pid: string; text: string };

export type PlayerStatus = 'playing' | 'waiting' | 'sittingOut' | 'busted' | 'spectating';

export interface PlayerView {
  id: string;
  name: string;
  seat: number | null;
  stack: number;
  status: PlayerStatus;
  /** Chose to sit out (takes effect from the next hand). */
  sittingOut: boolean;
  /** Has a working connection. */
  online: boolean;
  /** Connected but the game is in the background (another app or tab). */
  away: boolean;
  isHost: boolean;
  // Current hand (only for players dealt in)
  inHand: boolean;
  bet: number;
  folded: boolean;
  allIn: boolean;
  /** Two cards when visible to you, otherwise null (with inHand meaning they hold two face-down cards). */
  cards: Card[] | null;
  lastAction: string | null;
  /** Chips won in the last finished hand. */
  won: number;
  /** Name of the hand shown at showdown. */
  handName: string | null;
  /** The five cards that made their hand at showdown. */
  best: Card[] | null;
  rebuys: number;
}

export interface YourTurn {
  canCheck: boolean;
  callAmount: number;
  canRaise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
  isBet: boolean;
  /** Chips you have put in this street. */
  committed: number;
}

export interface TableView {
  code: string;
  you: string;
  hostId: string | null;
  settings: Settings;
  started: boolean;
  paused: boolean;
  players: PlayerView[];
  /** Blinds for the next (or current) hand. */
  smallBlind: number;
  bigBlind: number;
  blindLevel: number;
  /** When the blinds next go up (ms since epoch), or null. */
  nextLevelAt: number | null;
  hand: null | {
    id: number;
    street: Street;
    board: Card[];
    /** Pots from finished betting rounds (main pot first). */
    pots: number[];
    /** Everything in the middle, including this round's bets. */
    totalPot: number;
    currentBet: number;
    buttonSeat: number;
    sbSeat: number;
    bbSeat: number;
    toAct: string | null;
    /** When the player to act will be checked/folded automatically (ms since epoch), or null. */
    actDeadline: number | null;
    done: boolean;
    runout: boolean;
    /** Summary lines when the hand is over, e.g. "Sam wins 340 with a flush". */
    summary: string[];
    winners: string[];
    /** Players who chose to show cards after an uncontested win. */
    shown: string[];
  };
  you_turn: YourTurn | null;
  /** When the next hand will be dealt (ms since epoch), or null. */
  nextHandAt: number | null;
  log: { at: number; text: string }[];
  serverTime: number;
  /** When the host has been offline long enough that someone else may take over. */
  canClaimHost: boolean;
}
