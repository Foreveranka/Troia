// CHANNEL MODE (A-5): the allocateSeq/reallocateSeq effects must record WHICH account's sequence space the
// order rides — the pay() tx source and the deadness read's target — and must record nothing (null) on the
// single-operator allocator, whose provider has no channelFor.

import { describe, expect, it } from 'vitest';
import { perform } from '../../src/engine/perform.js';
import type { EngineDeps } from '../../src/engine/events.js';
import { FakeStore, makeCtx, makePreChargeCtx } from '../fakes/harness.js';

const CHANNEL = 'GCHANNELCHANNELCHANNELCHANNELCHANNELCHANNELCHANNELCHAN';

function depsWith(sequences: unknown): EngineDeps {
  return { store: { sequences } } as unknown as EngineDeps;
}

describe('allocateSeq — channel identity rides the ctx', () => {
  it('records the channel when the provider is a pool (channelFor present)', async () => {
    const store = new FakeStore();
    const ctx = makePreChargeCtx(store);
    const sequences = {
      allocate: () => 4242n,
      channelFor: (orderId: string) => (orderId === ctx.orderId ? CHANNEL : undefined),
    };
    const r = await perform('allocateSeq', ctx, 'UsdcSubmitted', null, depsWith(sequences));
    expect(r.ctxPatch).toEqual({ activeSeq: '4242', channelPublic: CHANNEL });
  });

  it('records NULL on the single-operator allocator (no channelFor) — behavior unchanged', async () => {
    const store = new FakeStore();
    const ctx = makePreChargeCtx(store);
    const r = await perform(
      'allocateSeq',
      ctx,
      'UsdcSubmitted',
      null,
      depsWith({ allocate: () => 4242n }),
    );
    expect(r.ctxPatch).toEqual({ activeSeq: '4242', channelPublic: null });
  });

  it('reallocateSeq keeps the sticky channel (re-read from the provider, same channel by contract)', async () => {
    const store = new FakeStore();
    const ctx = makeCtx(store, { channelPublic: CHANNEL });
    const sequences = {
      reallocate: () => 4243n,
      channelFor: () => CHANNEL,
    };
    const r = await perform('reallocateSeq', ctx, 'UsdcSubmitted', null, depsWith(sequences));
    expect(r.ctxPatch).toEqual({ activeSeq: '4243', channelPublic: CHANNEL });
  });
});
