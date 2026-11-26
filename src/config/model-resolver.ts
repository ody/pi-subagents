import type { Api, Model } from "@earendil-works/pi-ai";

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

export interface ModelRegistry {
  find(provider: string, modelId: string): Model<Api> | undefined;
  getAll(): Model<Api>[];
  getAvailable?(): Model<Api>[];
}

export interface ModelMatchOptions {
  scope?: Iterable<string>;
}

export type ModelMatch =
  | { kind: "resolved"; model: Model<Api> }
  | { kind: "unspecified" }
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: string[] };

type Rank = 1 | 2 | 3;

interface ModelQuery {
  literal: string;
  provider: string | undefined;
  text: string;
  base: string;
  snapshot: string | undefined;
  tokens: string[];
  version: string[];
}

const RANKS: Rank[] = [1, 2, 3];
const SNAPSHOT_SUFFIX = /-(\d{8})$/;
const TOKEN_SEPARATORS = /[^a-z0-9]+/;
const DIGITS = /\d+/g;
const LETTER = /[a-z]/;

export function describeModel(
  model: { provider: string; id: string; name?: string },
): { modelName: string; modelId: string } {
  return {
    modelName: (model.name ?? model.id).replace(/^Claude\s+/i, "").toLowerCase(),
    modelId: `${model.provider}/${model.id}`,
  };
}

export function getModelLabelFromConfig(model: string): string {
  const name = model.split("/").pop() ?? model;
  return name.replace(/-\d{8}$/, "");
}

function normalizeModelText(text: string): string {
  return text.trim().toLowerCase().replace(/\./g, "-");
}

function splitSnapshot(text: string): { base: string; snapshot: string | undefined } {
  const match = SNAPSHOT_SUFFIX.exec(text);
  if (!match) return { base: text, snapshot: undefined };
  return { base: text.slice(0, match.index), snapshot: match[1] };
}

function tokensOf(text: string): string[] {
  return text.split(TOKEN_SEPARATORS).filter(Boolean);
}

function versionOf(text: string): string[] {
  return tokensOf(text).flatMap(token => token.match(DIGITS) ?? []);
}

function containsAll(source: string[], wanted: string[]): boolean {
  const present = new Set(source);
  return wanted.every(token => present.has(token));
}

function sameVersion(modelVersion: string[], queryVersion: string[]): boolean {
  if (queryVersion.length === 0) return true;
  if (modelVersion.length !== queryVersion.length) return false;
  return modelVersion.every((part, index) => part === queryVersion[index]);
}

function parseQuery(input: string): ModelQuery | undefined {
  const normalized = normalizeModelText(input);
  if (!normalized) return undefined;
  const slash = normalized.indexOf("/");
  const provider = slash === -1 ? undefined : input.trim().toLowerCase().slice(0, slash);
  const text = slash === -1 ? normalized : normalized.slice(slash + 1);
  const { base, snapshot } = splitSnapshot(text);
  const tokens = tokensOf(base);
  if (tokens.length === 0 || !tokens.some(token => LETTER.test(token))) return undefined;
  return { literal: input.trim().toLowerCase(), provider, text, base, snapshot, tokens, version: versionOf(base) };
}

function entryKey(entry: ModelEntry): string {
  return `${entry.provider}/${entry.id}`.toLowerCase();
}

function entryParts(entry: ModelEntry): { base: string; snapshot: string | undefined } {
  return splitSnapshot(normalizeModelText(entry.id));
}

function entryBase(entry: ModelEntry): string {
  return entryParts(entry).base;
}

function entrySnapshot(entry: ModelEntry): string | undefined {
  return entryParts(entry).snapshot;
}

function shorthandRank(entry: ModelEntry, query: ModelQuery): Rank | undefined {
  if (query.snapshot !== undefined && entrySnapshot(entry) !== query.snapshot) return undefined;
  if (!sameVersion(versionOf(entryBase(entry)), query.version)) return undefined;
  if (containsAll(tokensOf(normalizeModelText(entry.id)), query.tokens)) return 3;
  return containsAll(tokensOf(normalizeModelText(entry.name)), query.tokens) ? 3 : undefined;
}

function matchRank(entry: ModelEntry, query: ModelQuery): Rank | undefined {
  const normalizedId = normalizeModelText(entry.id);
  if (normalizedId === query.text) return 1;
  if (query.snapshot === undefined && splitSnapshot(normalizedId).base === query.base) return 2;
  return shorthandRank(entry, query);
}

function availableModels(registry: ModelRegistry): ModelEntry[] {
  return (registry.getAvailable?.() ?? []) as ModelEntry[];
}

function winningScan(
  pool: ModelEntry[],
  query: ModelQuery,
): { rank: Rank; entries: ModelEntry[] } | undefined {
  for (const rank of RANKS) {
    const entries = pool.filter(entry => matchRank(entry, query) === rank);
    if (entries.length > 0) return { rank, entries };
  }
  return undefined;
}

function scanPool(
  pool: ModelEntry[],
  query: ModelQuery,
): { rank: Rank; entries: ModelEntry[] } | undefined {
  if (query.provider === undefined) return winningScan(pool, query);
  const local = pool.filter(entry => entry.provider.toLowerCase() === query.provider);
  return winningScan(local, query) ?? winningScan(pool, query);
}

function applyScope(entries: ModelEntry[], rank: Rank, scope: Iterable<string> | undefined): ModelEntry[] {
  if (rank !== 3 || scope === undefined || distinctBases(entries).size <= 1) return entries;
  const allowed = new Set(Array.from(scope, value => value.toLowerCase()));
  if (allowed.size === 0) return entries;
  return entries.filter(entry => allowed.has(entryKey(entry)));
}

function distinctBases(entries: ModelEntry[]): Set<string> {
  return new Set(entries.map(entryBase));
}

function compareEntries(a: ModelEntry, b: ModelEntry, query: ModelQuery): number {
  if (query.snapshot === undefined) {
    const datedA = entrySnapshot(a) === undefined ? 0 : 1;
    const datedB = entrySnapshot(b) === undefined ? 0 : 1;
    if (datedA !== datedB) return datedA - datedB;
  }
  const snapshotA = entrySnapshot(a) ?? "";
  const snapshotB = entrySnapshot(b) ?? "";
  if (snapshotA !== snapshotB) return snapshotA < snapshotB ? 1 : -1;
  const keyA = entryKey(a);
  const keyB = entryKey(b);
  if (keyA === keyB) return 0;
  return keyA < keyB ? -1 : 1;
}

export function matchModel(
  input: string,
  registry: ModelRegistry,
  options: ModelMatchOptions = {},
): ModelMatch {
  const query = parseQuery(input);
  if (!query) return { kind: "unspecified" };
  const pool = availableModels(registry);
  const literal = query.provider === undefined
    ? []
    : pool.filter(entry => entryKey(entry) === query.literal);
  const scan = literal.length > 0 ? { rank: 1 as Rank, entries: literal } : scanPool(pool, query);
  if (!scan) return { kind: "not_found" };
  const scoped = applyScope(scan.entries, scan.rank, options.scope);
  const candidates = scoped.length > 0 ? scoped : scan.entries;
  if (scoped.length === 0 || distinctBases(scoped).size > 1) {
    return { kind: "ambiguous", candidates: candidates.map(entryKey).sort() };
  }
  const winner = [...scoped].sort((a, b) => compareEntries(a, b, query))[0];
  return { kind: "resolved", model: winner as Model<Api> };
}
