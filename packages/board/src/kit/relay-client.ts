/**
 * A two-player match over the gauntlet relay (relay/server.mts), generalised from Rapture Chess. Two ways in:
 *
 *   placed   the LitNode arcade launched this page for a match the mesh placed (`?match=&ws=&room=&player=`): the
 *            arcade shell (the TCG kit's shell client, src/vendor/tcg/shell.ts) signs the seat challenge and, at the
 *            end, the match ledger; the relay posts the signed ledger to the node and the node's replay is the result;
 *   dev      a relay started with RELAY_DEV=1, rooms by name (`?relay=ws://127.0.0.1:7832&room=x&name=alice`).
 *
 * The relay echoes accepted entries; only those move the board, so both screens replay the same log.
 */
import { connectShell, parseLaunch, type CabinetShell, type LaunchParams } from '../vendor/tcg/shell';
import type { Side } from './game';
import { acceptDraw, concede, declineDraw, offerDraw, Op } from './match';
import { newRules, type LogEntry, type Match, type MatchEvents, type State } from './session';

/**
 * The clock as this client shows it. `deadline` is local time when the side to move runs out (or, before each side's
 * first move and untimed, when its move window closes); `left` is both sides' time in ms as of now, for a timed game.
 */
export interface RelayClock { side: Side; deadline: number; turnMs: number; left: [number, number]; timed: boolean; firstMove: boolean }
/** What the relay reports once the node settled (placed matches) or the game ended (dev). */
export interface RelaySettled { matchId: string; delta: Record<string, unknown> | null; seed: string; entries: LogEntry[]; dev: boolean; signatures: Record<string, string> }

export class RelayMatch implements Match {
  readonly rules = newRules();
  state: State;
  readonly log: LogEntry[] = [];
  seed = '';
  participants: [string, string] = ['side-0', 'side-1'];
  you: Side = 0;
  matchId = '';
  buildHash: string | null = null;
  rulesetId = '';
  settled: RelaySettled | null = null;
  clock: RelayClock | null = null;
  /** This player's own ledger signature, once made. */
  ledgerSig: string | null = null;
  readonly drawOffers = true;
  private ws: WebSocket | null = null;
  private started = false;
  private closed = false;
  private readonly settledListeners: Array<(s: RelaySettled) => void> = [];
  private readonly clockListeners: Array<(c: RelayClock) => void> = [];

  private constructor(private readonly events: MatchEvents, readonly playerId: string, private readonly shell: CabinetShell | null) {
    this.state = this.rules.init('pending', this.participants);
  }

  /** A placed match: the one the arcade launched this page for, seated through its shell. */
  static async placed(events: MatchEvents, via?: { launch: LaunchParams; shell: CabinetShell }): Promise<RelayMatch> {
    const launch = via?.launch ?? parseLaunch();
    const shell = via?.shell ?? await connectShell();
    const you = shell.init.player.id;
    const m = new RelayMatch(events, you, shell);
    const wsAddr = launch.ws ?? shell.init.match?.wsAddr ?? null;
    const room = launch.room ?? (launch.matchId ? `LIT-${launch.matchId.slice(0, 32).toUpperCase()}` : null);
    if (!wsAddr || !room) throw new Error('no relay in the launch: open this game from the LitNode arcade');
    m.matchId = launch.matchId ?? shell.init.match?.matchId ?? '';
    m.buildHash = launch.buildHash ?? shell.init.match?.buildHash ?? null;
    events.onStatus('claiming your seat…');
    const base = `${wsAddr.replace(/^ws/, 'http').replace(/\/+$/, '')}/${room}/ticket?player=${encodeURIComponent(you)}`;
    // First ask returns a one-time nonce; the second carries the player key's signature over it.
    const first = await fetch(base).then((r) => r.json()) as { challenge?: { matchId: string; room: string; player: string; nonce: string }; error?: string };
    if (!first.challenge) throw new Error(first.error ?? 'seat: no challenge');
    const sig = await shell.signSeat(first.challenge);
    const seat = await fetch(`${base}&nonce=${first.challenge.nonce}&sig=${sig}`).then((r) => r.json()) as { ticket?: string; ws?: string; error?: string };
    if (!seat.ticket || !seat.ws) throw new Error(seat.error ?? 'seat: no ticket');
    m.open(seat.ws, { t: 'hello', ticket: seat.ticket });
    return m;
  }

  /** A dev relay room: `url` is the relay origin, players name themselves. */
  static dev(events: MatchEvents, url: string, room: string, name: string): RelayMatch {
    const m = new RelayMatch(events, name, null);
    m.open(url.replace(/\/+$/, ''), { t: 'hello', room, player: name });
    return m;
  }

  get yourTurn(): boolean { return this.started && !this.state.over && this.state.turn === this.you; }

  act(action: number): boolean {
    if (!this.started || this.closed) return false;
    if ((action & 7) !== Op.Concede && (!this.yourTurn || !this.rules.isLegal(this.state, action))) return false;
    this.ws?.send(JSON.stringify({ t: 'act', x: action | 0 }));
    return true;
  }
  concede(): void { this.act(concede()); }
  offerDraw(): boolean { return this.draw(offerDraw()); }
  acceptDraw(): boolean { return this.draw(acceptDraw()); }
  declineDraw(): boolean { return this.draw(declineDraw()); }
  private draw(x: number): boolean {
    if (!this.started || this.closed || !this.rules.canDraw(this.state, this.you, x)) return false;
    this.ws?.send(JSON.stringify({ t: 'act', x }));
    return true;
  }
  poke(): void { /* the relay pushes the opponent's entries */ }
  close(): void { this.closed = true; this.ws?.close(); this.ws = null; this.shell?.close(); }
  /** Tell the arcade the match was played (it closes the title). */
  played(): void { this.shell?.exit(); }

  onSettled(cb: (s: RelaySettled) => void): void { this.settledListeners.push(cb); if (this.settled) cb(this.settled); }
  onClock(cb: (c: RelayClock) => void): void { this.clockListeners.push(cb); }

  // ------------------------------------------------------------------ transport
  private open(url: string, hello: Record<string, unknown>): void {
    const ws = new WebSocket(url);
    this.ws = ws;
    this.events.onStatus('connecting to the match…');
    ws.onopen = () => ws.send(JSON.stringify(hello));
    ws.onclose = () => { if (!this.closed) this.events.onStatus(this.state.over ? 'match over' : 'disconnected from the relay'); };
    ws.onerror = () => this.events.onStatus('relay connection failed');
    ws.onmessage = (ev) => { void this.onServer(JSON.parse(String(ev.data))); };
  }

  private async onServer(m: { t: string; [k: string]: unknown }): Promise<void> {
    switch (m.t) {
      case 'seated':
        this.you = Number(m.side) === 1 ? 1 : 0;
        this.events.onStatus(Number(m.waiting) > 0 ? 'seated, waiting for the opponent…' : 'both seated, starting…');
        break;
      case 'start': {
        if (this.started) break;
        this.seed = String(m.seed);
        this.matchId = String(m.matchId);
        this.rulesetId = String(m.rulesetId ?? '');
        this.buildHash = (m.buildHash as string | null) ?? this.buildHash;
        this.participants = m.participants as [string, string];
        this.you = this.participants[1] === this.playerId ? 1 : 0;
        this.state = this.rules.init(this.seed, this.participants);
        this.started = true;
        for (const e of (m.entries as LogEntry[]) ?? []) this.apply(e, false);
        this.setClock(m);
        this.events.onStatus(this.yourTurn ? 'your move' : 'live: opponent to move');
        this.events.onStep({ k: -1, inputs: [0, 0] }, this.state, this.state);
        break;
      }
      case 'entry':
        this.apply(m.entry as LogEntry, true);
        this.setClock(m);
        break;
      case 'reject':
        this.events.onStatus(`rejected: ${String(m.reason)}`);
        break;
      case 'away':
        this.events.onStatus(`opponent disconnected; they concede in ${Math.round(Number(m.graceMs) / 1000)} s unless they return`);
        break;
      case 'sign': {
        // Sign the log THIS client recorded; the arcade shell recomputes the chain head from it.
        if (!this.shell) { this.events.onStatus('match over (dev relay: unsigned)'); break; }
        this.events.onStatus('signing the match ledger…');
        try {
          const sig = await this.shell.signLedger(String(m.matchId), (m.buildHash as string | null) ?? null, this.log);
          this.ledgerSig = sig;
          this.ws?.send(JSON.stringify({ t: 'sig', sig }));
          this.events.onStatus('settling on LitNode…');
        } catch (e) { this.events.onStatus(`not signed: ${(e as Error).message}`); }
        break;
      }
      case 'settled': {
        const signatures = { ...((m.signatures as Record<string, string> | undefined) ?? {}), ...(this.ledgerSig ? { [this.playerId]: this.ledgerSig } : {}) };
        const s: RelaySettled = { matchId: this.matchId, delta: (m.delta as Record<string, unknown> | null) ?? null, seed: String(m.seed ?? this.seed), entries: (m.entries as LogEntry[]) ?? this.log, dev: !!m.dev, signatures };
        this.settled = s;
        const d = s.delta as { attestation?: string; proof?: string; placed?: boolean } | null;
        this.events.onStatus(d ? `settled on LitNode: ${d.proof ?? d.attestation ?? 'recorded'}${d.placed === false ? ' (unplaced, casual)' : ''}` : 'match over');
        for (const cb of this.settledListeners) cb(s);
        break;
      }
      case 'error':
        this.events.onStatus(`relay: ${String(m.message)}`);
        break;
    }
  }

  private apply(entry: LogEntry, notify: boolean): void {
    if (entry.k !== this.log.length) return;   // out of order: the start replay covers it
    const prev = this.state;
    this.state = this.rules.step(this.state, { [this.participants[0]]: entry.inputs[0], [this.participants[1]]: entry.inputs[1] });
    this.log.push(entry);
    if (notify) this.events.onStep(entry, prev, this.state);
  }

  /** The relay's clock report: `remaining` is what the side to move has, as of the message. */
  private setClock(m: { [k: string]: unknown }): void {
    if (this.state.over) return;
    const remaining = Number(m.remaining), turnMs = Number(m.turnMs) || 60_000;
    if (!Number.isFinite(remaining)) return;
    const side = this.state.turn, timed = !!this.state.tc;
    const left: [number, number] = [this.state.left[0], this.state.left[1]];
    if (timed && !m.firstMove) left[side] = remaining;
    this.clock = { side, deadline: Date.now() + remaining, turnMs, left, timed, firstMove: !!m.firstMove };
    for (const cb of this.clockListeners) cb(this.clock);
  }
}
