/**
 * The shape of `board.config.ts`: everything about a board game that is not its rules or its pieces. The ruleset
 * imports it too (title, id, move limit, modes), so it must stay plain data: no DOM, no imports but types.
 */

export interface SideConfig {
  /** "White", "Black", "Red"… shown in the HUD. */
  name: string;
  /** The pieces' base colour. */
  color: string;
  /** The coloured accent light on this side's corner of the board. */
  light: string;
}

/** The arena round the board: a neutral procedural hall, or your own GLB (Blender export) with a lighting preset. */
export interface ArenaConfig {
  /** A GLB under public/ (e.g. "models/arena.glb"), or null for the built-in neutral dais. */
  model: string | null;
  sky: { top: string; bottom: string; glow: string; fog: string; fogDensity: number };
  stars: number;
  key: { color: string; intensity: number; position: [number, number, number] };
  rim: { color: string; intensity: number };
  hemi: { sky: string; ground: string; intensity: number };
  /** The polished dais round the board (a mirror on the high presets): its radius in squares, 0 for none. */
  floorRadius: number;
  /** Light shafts along the key light, ground mist and drifting motes. */
  atmosphere: { shafts: { color: string; intensity: number; count: number }; mist: { color: string; opacity: number }; motes: { color: string; base: number; rise: number; size: number } };
  /** Godrays through the shadow map. */
  rays: { color: string; density: number; maxDensity: number; distanceAttenuation: number };
  /** The soft pool of light on the board. */
  pool: { color: string; intensity: number; angle: number };
  /** Colour grade after tone mapping: lift, gamma, gain per channel. */
  grade: { lift: [number, number, number]; gamma: [number, number, number]; gain: [number, number, number] };
}

/** An ERC-721 collection whose holders get their tokens seated on the board first (wallet seating). */
export interface CollectionConfig {
  name: string;
  address: string;
  chainId: number;
  /** JSON-RPC for reads (holdings never go through the wallet). */
  rpc: string;
  /** Blockscout-style explorer base URL, for the holdings hint; optional. */
  explorer?: string;
  /** A snapshot of the collection's tokens (public/…json: `{ cards: [{ tokenId, name, … }] }`), or null to seat owned token ids alone. */
  cards: string | null;
  /** The token-id set the holdings scan walks (setId << 32 | serial, the Rapture collection layout); default 1. */
  setId?: number;
}

export interface BoardConfig {
  title: string;
  /** The LitNode ruleset id, `name.vN`. Claim your own: TitleRegistry is first come, first served. Any change to the rules is a new N. */
  rulesetId: string;
  description: string;
  /** Where the client is hosted: the arcade launches it in an iframe. null until it is deployed. */
  url: string | null;
  /** The arcade's accent colour for the title. */
  accent: string;
  board: {
    files: number;
    ranks: number;
    /** Letters for the files, for square names ("abcdefgh"). */
    fileNames: string;
    light: string;
    dark: string;
    frame: string;
  };
  sides: [SideConfig, SideConfig];
  arena: ArenaConfig;
  pieces: {
    /**
     * GLB models per piece kind (paths under public/, e.g. { k: 'models/king.glb' }), replacing the procedural pieces of
     * src/game/pieces.ts; any kind left out stays procedural. Model at board scale (one unit is one square), standing
     * on y = 0 and facing +z; side 1's pieces are turned round. Draco and meshopt compression are fine.
     */
    models: Record<string, string>;
  };
  /** The relay's defaults (each one can be overridden in the gauntlet's env). */
  clock: {
    /** "<minutes>+<increment seconds>" (5+3), or "none" for an untimed game. */
    control: string;
    /** Each side's first move is off the clock but must come within this window. */
    firstMoveMs: number;
    /** Untimed games: the window for every move. */
    turnMs: number;
  };
  /** A log longer than this ends drawn: the manifest's maxTicks. */
  maxBeats: number;
  modes: Array<'ranked' | 'casual'>;
  leaderboard: { kind: 'elo'; k: number } | null;
  collection: CollectionConfig | null;
  /** localStorage prefix for this game's settings. */
  storageKey: string;
}
