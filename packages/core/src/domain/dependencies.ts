/**
 * The one dependency rule (ADR-0071, ADR-0096): an item may start only when every item it depends
 * on is done. A system plan's steps (`readySteps`) and the Backlog's children (`issue start`,
 * `waitsFor`) both ask it here, so the two never disagree.
 */
export interface Dependent {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

/** The dependencies of `item` that are not done yet, in the order it names them; an unknown one is never done. */
export function unmetDependencies<T extends Dependent>(
  item: Dependent,
  items: readonly T[],
  done: (other: T) => boolean,
): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return item.dependsOn.filter((id) => {
    const dependency = byId.get(id);
    return dependency === undefined || !done(dependency);
  });
}

/** The items that can start now: still waiting, with every dependency done. */
export function readyItems<T extends Dependent>(
  items: readonly T[],
  done: (item: T) => boolean,
  waiting: (item: T) => boolean,
): T[] {
  return items.filter((i) => waiting(i) && unmetDependencies(i, items, done).length === 0);
}
