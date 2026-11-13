/**
 * Matches the client can play, all recorded as the same `{ k, inputs: [side 0, side 1] }` log a relay and a LitNode
 * ruleset replay: LocalMatch (you against the practice bot, or two players on one screen) here, RelayMatch (a dev
 * room, or a match the LitNode arcade placed) in relay-client.ts.
 */
import config from '../../board.config';
import { game } from '../game/rules';
import type { Side } from './game';
import { concede, createMatchRules, Op, type MatchRules, type MatchState } from './match';

export type Position = ReturnType<typeof game.setup>;
export type State = MatchState<Position>;
export interface LogEntry { k: number; inputs: [number, number] }

export interface MatchEvents {
  /** A log entry was accepted: the state before and after it. */
  onStep(entry: LogEntry, prev: State, state: State): void;
  onStatus(text: string): void;
}

/** What the board and the HUD need from any match. */
export interface Match {
  readonly rules: MatchRules<Position>;
  readonly state: State;
  readonly log: LogEntry[];
  readonly seed: string;
  /** The side this screen plays (a hot-seat game: the side to move). */
  readonly you: Side;
  readonly participants: [string, string];
  readonly yourTurn: boolean;
  /** Your action; false when it is not your turn or not legal. */
  act(action: number): boolean;
  concede(): void;
  /** Whether this match takes draw offers (a relayed match; the bot does not). */
  readonly drawOffers: boolean;
  offerDraw(): boolean;
  acceptDraw(): boolean;
  declineDraw(): boolean;
  /** Ask the opponent (the bot) to act when it is their turn. */
  poke(): void;
  close(): void;
}

export const newRules = (): MatchRules<Position> => createMatchRules(game, { maxBeats: config.maxBeats });

export class LocalMatch implements Match {
  readonly rules = newRules();
  state: State;
  readonly log: LogEntry[] = [];
  readonly participants: [string, string] = ['side-0', 'side-1'];
  readonly drawOffers = false;
  private worker: Worker | null = null;
  private pending = 0;
  private closed = false;

  /** `bot`: the practice bot plays the other side; otherwise two players share the screen. */
  constructor(readonly seed: string, private readonly side: Side, private readonly events: MatchEvents, private readonly bot = true, private readonly botBudgetMs = 900) {
    this.state = this.rules.init(seed, this.participants);
  }

  get you(): Side { return this.bot ? this.side : this.state.turn; }
  get yourTurn(): boolean { return !this.state.over && this.state.turn === this.you; }

  act(action: number): boolean {
    if ((action & 7) === Op.Concede) { this.record(this.you, action); return true; }
    if (!this.yourTurn || !this.rules.isLegal(this.state, action)) return false;
    this.record(this.you, action);
    return true;
  }
  concede(): void { this.act(concede()); }
  offerDraw(): boolean { return false; }
  acceptDraw(): boolean { return false; }
  declineDraw(): boolean { return false; }

  /** Ask the bot (a worker, so the board never stutters) for the other side's move. */
  poke(): void {
    if (!this.bot || this.closed || this.state.over || this.state.turn === this.side) return;
    this.events.onStatus('the bot is thinking…');
    const id = ++this.pending;
    const w = this.worker ?? (this.worker = new Worker(new URL('./bot.worker.ts', import.meta.url), { type: 'module' }));
    w.onmessage = (ev: MessageEvent<{ id: number; action: number }>) => {
      if (ev.data.id !== id || this.closed) return;
      this.record(this.side === 0 ? 1 : 0, ev.data.action);
    };
    w.postMessage({ id, pos: this.state.pos, budgetMs: this.botBudgetMs });
  }

  private record(side: Side, action: number): void {
    const inputs: [number, number] = side === 0 ? [action | 0, 0] : [0, action | 0];
    const prev = this.state;
    this.state = this.rules.step(this.state, { [this.participants[0]]: inputs[0], [this.participants[1]]: inputs[1] });
    if (!this.state.last) return; // a no-op beat is not recorded (the relay drops those too)
    const entry: LogEntry = { k: this.log.length, inputs };
    this.log.push(entry);
    this.events.onStep(entry, prev, this.state);
  }

  close(): void { this.closed = true; this.worker?.terminate(); this.worker = null; }
}
