// scenario.ts — the authenticated viewer's identity, derived from the public scenario seed.
//
// The suite logs in as one viewer whose login, name and email come from a fixed seeded
// generator (the kit publishes the seed and the generator's shape). The entry must derive the
// same viewer, or the checks' repositories land under the wrong owner and every ownership
// check fails. The seed may arrive through MAKEFUN_SCENARIO_SEED; without it the kit's
// published default seed is used. No clock, no Math.random: the derivation is pure.
//
// The generator: a 64-bit FNV-1a hash of a stream label, mixed with the scenario seed through
// the splitmix64 finalizer, feeds an xorshift64* stream. Users are drawn first-name /
// last-name pairs, deduplicated with a -2, -3, ... suffix. The viewer is users[0].

export const SCENARIO_SEED_HEX = '6a09e667f3bcc909';

/** 2025-01-01T00:00:00Z; generated timestamps are this plus a seeded offset. */
export const SCENARIO_EPOCH_SEC = 1_735_689_600;

/** The default branch every repository is born with. */
export const DEFAULT_BRANCH = 'main';

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED_DEFAULT = 0x6a09e667f3bcc909n;

/** FNV-1a, 64-bit: a label's stable seed contribution. */
export function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer: a seeded value with every bit mixed into every other. */
export function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** The scenario seed as a bigint, from the environment or the published default. */
export function scenarioSeed(): bigint {
  const raw = (process.env.MAKEFUN_SCENARIO_SEED ?? '').trim().toLowerCase();
  if (/^[0-9a-f]{1,16}$/.test(raw)) {
    try {
      return BigInt(`0x${raw}`);
    } catch {
      // fall through to the default
    }
  }
  return SCENARIO_SEED_DEFAULT;
}

/** The seed a named stream starts from: a stable function of the seed and the label. */
export function scenarioSeedFor(label: string, seed: bigint): bigint {
  return mix64(seed ^ fnv1a64(label));
}

/**
 * xorshift64*: a 64-bit state walked by three shifts and one multiply. Every method is
 * deterministic and has no hidden state but the current state.
 */
export class Rng {
  #state: bigint;

  constructor(seed: bigint, fallback: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? fallback : masked;
  }

  /** The next 64-bit value. */
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  /** The next 32-bit value, from the top half of nextU64(). */
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), unbiased by rejection. */
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  /** A number in [0, 1), 32 bits of resolution. */
  fraction(): number {
    return this.nextU32() / 4_294_967_296;
  }

  /** True with probability `probability`. */
  chance(probability: number): boolean {
    return this.fraction() < probability;
  }

  /** One element, uniformly. */
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

/** A named stream: same label, same numbers, in any process and any order of use. */
export function scenarioRng(label: string, seed: bigint): Rng {
  return new Rng(scenarioSeedFor(label, seed), seed);
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];

const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface ViewerUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** `count` users with unique logins, deterministic for the stream. */
export function generateUsers(rng: Rng, count: number): ViewerUser[] {
  const used = new Set<string>();
  const users: ViewerUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

/**
 * The viewer: users[0] of the 'users' stream. When the derivation cannot run (a bad seed
 * in the environment, an empty name list), the caller falls back to learn-and-lock: the
 * first login that authenticates successfully becomes the viewer.
 */
export function deriveViewer(): ViewerUser | null {
  try {
    const seed = scenarioSeed();
    const users = generateUsers(scenarioRng('users', seed), 12);
    return users[0] ?? null;
  } catch {
    return null;
  }
}
