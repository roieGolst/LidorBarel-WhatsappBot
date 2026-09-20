import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryGate } from './deliveryGate.js';

describe('deliveryGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases a wait when the message is delivered', async () => {
    const gate = createDeliveryGate({ timeoutMs: 15_000 });
    const wait = gate.waitForDelivery('wamid.1');

    gate.notify('wamid.1', 'delivered');

    await expect(wait).resolves.toBe('delivered');
  });

  it('treats read as delivered — the two can arrive in either order', async () => {
    const gate = createDeliveryGate();
    const wait = gate.waitForDelivery('wamid.1');

    gate.notify('wamid.1', 'read');

    await expect(wait).resolves.toBe('delivered');
  });

  it('does NOT release on sent: a later text can still overtake the clip', async () => {
    const gate = createDeliveryGate({ timeoutMs: 15_000 });
    let outcome: string | undefined;
    void gate.waitForDelivery('wamid.1').then((o) => (outcome = o));

    gate.notify('wamid.1', 'sent');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome).toBeUndefined();

    gate.notify('wamid.1', 'delivered');
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBe('delivered');
  });

  it('reports a failed delivery so the caller can fall back', async () => {
    const gate = createDeliveryGate();
    const wait = gate.waitForDelivery('wamid.1');

    gate.notify('wamid.1', 'failed');

    await expect(wait).resolves.toBe('failed');
  });

  it('falls through on the timeout rather than holding the turn forever', async () => {
    const gate = createDeliveryGate({ timeoutMs: 15_000 });
    const wait = gate.waitForDelivery('wamid.1');

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(wait).resolves.toBe('timeout');
  });

  it('remembers a status that beat the wait — the webhook races the API response', async () => {
    const gate = createDeliveryGate();

    gate.notify('wamid.1', 'delivered');

    await expect(gate.waitForDelivery('wamid.1')).resolves.toBe('delivered');
  });

  it('forgets a remembered status after the retention window', async () => {
    const gate = createDeliveryGate({ timeoutMs: 1_000, retainMs: 60_000 });
    gate.notify('wamid.old', 'delivered');

    await vi.advanceTimersByTimeAsync(61_000);
    // Pruning happens on the next status, of any message.
    gate.notify('wamid.other', 'delivered');

    const wait = gate.waitForDelivery('wamid.old');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(wait).resolves.toBe('timeout');
  });

  it('only releases the message the status is about', async () => {
    const gate = createDeliveryGate({ timeoutMs: 15_000 });
    let outcome: string | undefined;
    void gate.waitForDelivery('wamid.1').then((o) => (outcome = o));

    gate.notify('wamid.2', 'delivered');
    await vi.advanceTimersByTimeAsync(0);

    expect(outcome).toBeUndefined();
  });

  it('releases every wait on the same message', async () => {
    const gate = createDeliveryGate();
    const first = gate.waitForDelivery('wamid.1');
    const second = gate.waitForDelivery('wamid.1');

    gate.notify('wamid.1', 'delivered');

    await expect(Promise.all([first, second])).resolves.toEqual([
      'delivered',
      'delivered',
    ]);
  });
});
