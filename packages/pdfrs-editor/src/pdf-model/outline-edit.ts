// Edits on an outline kept as a flat list of entries with levels (as
// `read_outline` gives it): an entry's children are the entries right after
// it with a deeper level. Every function returns a new list and leaves the
// one it was given alone; an edit that can't be done returns null.
import type { OutlineEntry, PageId } from "./types";

/** The index right after the entry at `index` and all its descendants. */
export function subtreeEnd(entries: readonly OutlineEntry[], index: number): number {
  const level = entries[index]!.level;
  let end = index + 1;
  while (end < entries.length && entries[end]!.level > level) end++;
  return end;
}

function checkIndex(entries: readonly OutlineEntry[], index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    throw new Error(`voce dell'indice ${index} inesistente (l'indice ne ha ${entries.length})`);
  }
}

/** The index of the previous sibling of `index` (same level, same parent), or -1. */
function previousSibling(entries: readonly OutlineEntry[], index: number): number {
  const level = entries[index]!.level;
  for (let i = index - 1; i >= 0; i--) {
    const other = entries[i]!.level;
    if (other === level) return i;
    if (other < level) return -1;
  }
  return -1;
}

/** Without the entry at `index` and its descendants. */
export function removeEntry(entries: readonly OutlineEntry[], index: number): OutlineEntry[] {
  checkIndex(entries, index);
  return [...entries.slice(0, index), ...entries.slice(subtreeEnd(entries, index))];
}

/** With the entry at `index` renamed. */
export function renameEntry(entries: readonly OutlineEntry[], index: number, title: string): OutlineEntry[] {
  checkIndex(entries, index);
  return entries.map((entry, i) => (i === index ? { ...entry, title } : entry));
}

/** An edited outline, and where the entry that was edited is in it now. */
export interface Moved {
  entries: OutlineEntry[];
  index: number;
}

/**
 * The entry at `index`, with its descendants, swapped with its previous
 * (`by` -1) or next (`by` 1) sibling and that one's descendants. Null at
 * the start or end of its branch.
 */
export function moveEntry(entries: readonly OutlineEntry[], index: number, by: -1 | 1): Moved | null {
  checkIndex(entries, index);
  const end = subtreeEnd(entries, index);
  if (by === -1) {
    const before = previousSibling(entries, index);
    if (before === -1) return null;
    return {
      entries: [
        ...entries.slice(0, before),
        ...entries.slice(index, end),
        ...entries.slice(before, index),
        ...entries.slice(end),
      ],
      index: before,
    };
  }
  const next = entries[end];
  if (!next || next.level !== entries[index]!.level) return null;
  const nextEnd = subtreeEnd(entries, end);
  return {
    entries: [
      ...entries.slice(0, index),
      ...entries.slice(end, nextEnd),
      ...entries.slice(index, end),
      ...entries.slice(nextEnd),
    ],
    index: index + (nextEnd - end),
  };
}

/**
 * The entry at `index` and its descendants one level deeper: the entry
 * becomes the last child of its previous sibling. Null without one.
 */
export function indentEntry(entries: readonly OutlineEntry[], index: number): Moved | null {
  checkIndex(entries, index);
  if (previousSibling(entries, index) === -1) return null;
  const end = subtreeEnd(entries, index);
  return {
    entries: entries.map((entry, i) => (i >= index && i < end ? { ...entry, level: entry.level + 1 } : entry)),
    index,
  };
}

/**
 * The entry at `index` and its descendants one level up: the entry moves
 * after the rest of its parent's children, becoming the parent's next
 * sibling (so the siblings that followed it stay where they were). Null at
 * the top level.
 */
export function outdentEntry(entries: readonly OutlineEntry[], index: number): Moved | null {
  checkIndex(entries, index);
  const level = entries[index]!.level;
  if (level <= 1) return null;
  let parent = index - 1;
  while (entries[parent]!.level >= level) parent--;
  const end = subtreeEnd(entries, index);
  const parentEnd = subtreeEnd(entries, parent);
  const moved = entries.slice(index, end).map((entry) => ({ ...entry, level: entry.level - 1 }));
  return {
    entries: [...entries.slice(0, index), ...entries.slice(end, parentEnd), ...moved, ...entries.slice(parentEnd)],
    index: parentEnd - (end - index),
  };
}

/**
 * Where an entry for `page` goes, and at which level: right after the
 * branch of the last entry whose page comes no later than `page` in
 * `order` (the display order), as its sibling; at the top when none does.
 */
export function placeForPage(
  entries: readonly OutlineEntry[],
  page: PageId,
  order: readonly PageId[],
): { index: number; level: number } {
  const position = new Map(order.map((id, index) => [id, index]));
  const target = position.get(page) ?? Infinity;
  let after = -1;
  entries.forEach((entry, index) => {
    const at = entry.page != null ? position.get(entry.page) : undefined;
    if (at !== undefined && at <= target) after = index;
  });
  if (after === -1) return { index: 0, level: 1 };
  return { index: subtreeEnd(entries, after), level: entries[after]!.level };
}

/**
 * `incoming` (entries of pages just inserted, already pointing at their
 * ids here) merged into `entries`: before the first top-level entry whose
 * page comes after the first inserted page in `order`, or at the end.
 */
export function mergeIncoming(
  entries: readonly OutlineEntry[],
  incoming: readonly OutlineEntry[],
  order: readonly PageId[],
): OutlineEntry[] {
  if (incoming.length === 0) return [...entries];
  const position = new Map(order.map((id, index) => [id, index]));
  const first = Math.min(...incoming.map((entry) => position.get(entry.page ?? -1) ?? Infinity));
  const at = entries.findIndex((entry) => {
    const page = entry.page != null ? position.get(entry.page) : undefined;
    return entry.level === 1 && page !== undefined && page > first;
  });
  const index = at === -1 ? entries.length : at;
  return [...entries.slice(0, index), ...incoming, ...entries.slice(index)];
}
