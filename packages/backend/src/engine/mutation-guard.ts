// Belt-and-suspenders enforcement of "Unknown/recover/still-pending NEVER advances toward an irreversible
// action". The core state machine is structurally correct (it only emits rePollObserveOnly on those rows),
// but the engine also asserts it before performing any effect, so a future table change cannot silently open
// a mutation-on-uncertainty hole. A pure property test folds every (state,event) through transition() to
// prove MUTATION_EFFECTS never co-occur with an observe-only event.

import { MUTATION_EFFECTS } from '@troia/core';
import type { Effect, Event } from '@troia/core';

const MUTATION: ReadonlySet<Effect> = new Set(MUTATION_EFFECTS);

/** An event that must never drive a money-moving / auth-placing effect — i.e. every event whose transition
 *  is observe-only (still-in-flight / uncertain). This MUST cover every event the core pairs with
 *  rePollObserveOnly; the property test enforces that agreement against the transition table. `evidencePending`
 *  is included: a pay() tx observed as neither confirmed nor reverted is still in flight, so any resubmit
 *  would be a double-spend — identical semantics to its sibling `pollStillPending`. */
export function isObserveOnlyEvent(event: Event): boolean {
  return (
    event.type.endsWith('Unknown') ||
    event.type === 'recover' ||
    event.type === 'pollStillPending' ||
    event.type === 'evidencePending'
  );
}

export function containsMutation(effects: readonly Effect[]): boolean {
  return effects.some((e) => MUTATION.has(e));
}

/** Throw (dead-letter) if an observe-only event is about to drive a mutation effect. */
export function assertNoMutationOnUnknown(event: Event, effects: readonly Effect[]): void {
  if (isObserveOnlyEvent(event) && containsMutation(effects)) {
    throw new Error(
      `mutation effect on observe-only event '${event.type}': [${effects.join(', ')}] — refused`,
    );
  }
}
