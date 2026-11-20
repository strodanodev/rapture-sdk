/**
 * Character unlocks: which collection cards a player may use off chain (practice and the Gauntlet) without holding
 * the NFT. A player picks one starter, earns more in the Gauntlet (one per run that wins UNLOCK_AT
 * stages), and anything their wallet holds is open too. Support cards (no `token`) are always open. Ranked never reads this: the relay checks the wallet on chain.
 *
 * Pure data and functions, like the profile; where the record is kept is the caller's `Store`. Nothing here is a
 * rule, and the settings are the caller's (not game.json, whose bytes are part of the published ruleset).
 */
import type { CompiledGame } from '../core/game';
import { START_HEAT } from './gauntlet';
import { gameKey, type Store } from './profile';

export interface Unlocks {
  v: 1;
  /** The game, by rulesetId without its version (as the profile): unlocks outlive balance patches. */
  game: string;
  /** The starter's token id, once picked. */
  starter: string | null;
  /** Token ids earned in the Gauntlet, oldest first. */
  earned: string[];
  /** The Gauntlet's dynamic difficulty for this player (Gauntlet.heatAfter moves it after each locked run). */
  heat: number;
}

const storageKey = (game: string): string => `deckwright.unlocks.${game}`;

export const emptyUnlocks = (game: string): Unlocks => ({ v: 1, game, starter: null, earned: [], heat: START_HEAT });

const isId = (x: unknown): x is string => typeof x === 'string' && /^\d{1,78}$/.test(x);

/** Load the record; anything unreadable starts fresh rather than failing. */
export function loadUnlocks(store: Store | null, rulesetId: string): Unlocks {
  const game = gameKey(rulesetId);
  try {
    const raw = store?.getItem(storageKey(game));
    const u = raw ? (JSON.parse(raw) as Unlocks) : null;
    if (u && u.v === 1 && u.game === game && (u.starter === null || isId(u.starter)) && Array.isArray(u.earned) && u.earned.every(isId) && Number.isInteger(u.heat)) return u;
  } catch { /* storage blocked or corrupt: a fresh record */ }
  return emptyUnlocks(game);
}

export function saveUnlocks(store: Store | null, unlocks: Unlocks): void {
  try { store?.setItem(storageKey(unlocks.game), JSON.stringify(unlocks)); } catch { /* private mode or full: keep playing */ }
}

/** The token ids a new player may pick their starter from: deckable collection cards of `kind` (a Rapture Kind). */
export function starterChoices(game: CompiledGame, kind: string): string[] {
  return game.cards.filter((c) => c.token && c.kind === kind && c.deckable !== false).map((c) => String(c.token!.tokenId));
}

/** Pick the starter: once, and only one of `choices`. Anything else leaves the record as it was. */
export function pickStarter(unlocks: Unlocks, tokenId: string, choices: string[]): Unlocks {
  return unlocks.starter === null && choices.includes(String(tokenId)) ? { ...unlocks, starter: String(tokenId) } : unlocks;
}

/** Add an earned token id (no duplicates). */
export function addUnlock(unlocks: Unlocks, tokenId: string): Unlocks {
  const id = String(tokenId);
  return unlocks.starter === id || unlocks.earned.includes(id) ? unlocks : { ...unlocks, earned: [...unlocks.earned, id] };
}

/**
 * This device's record merged with an account's (signing in): the account's starter wins, and a different starter
 * picked here is kept as earned, so nothing anyone unlocked is lost. The account's `heat` wins when it has one.
 */
export function mergeUnlocks(local: Unlocks, account: { starter?: string | null; earned?: string[]; heat?: number | null }): Unlocks {
  const starter = account.starter ?? local.starter;
  const earned = [...new Set([...(account.earned ?? []), ...local.earned, ...(local.starter ? [local.starter] : [])].map(String))].filter((id) => isId(id) && id !== starter);
  return { ...local, starter, earned, heat: Number.isInteger(account.heat) ? (account.heat as number) : local.heat };
}

/** Every token id the player may use: the starter, the earned ones and the ones the wallet holds. */
export function unlockedTokens(unlocks: Unlocks, owned: Iterable<string> = []): Set<string> {
  return new Set([...(unlocks.starter ? [unlocks.starter] : []), ...unlocks.earned, ...[...owned].map(String)]);
}

/** May this card be used? Support cards always; a collection card when its token is unlocked. */
export const cardUnlocked = (card: { token?: { tokenId: string } }, unlocked: Set<string>): boolean => !card.token || unlocked.has(String(card.token.tokenId));
