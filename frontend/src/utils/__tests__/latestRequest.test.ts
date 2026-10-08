import { createLatestRequestGate } from '../latestRequest';

/**
 * Overlapping refetches of a review page (F13): only the response of the newest request is
 * applied, so an older one that lands last can't put back a list without a change the newer
 * one had.
 */
describe('createLatestRequestGate', () => {
  it('only the newest request is current, whatever order the responses land in', async () => {
    const gate = createLatestRequestGate();
    const applied: string[] = [];
    const request = async (name: string, delay: number) => {
      const isCurrent = gate.start();
      await new Promise((r) => setTimeout(r, delay));
      if (isCurrent()) applied.push(name);
    };
    await Promise.all([request('older', 30), request('newer', 5)]);
    expect(applied).toEqual(['newer']);
  });

  it('a request is current until another starts', () => {
    const gate = createLatestRequestGate();
    const first = gate.start();
    expect(first()).toBe(true);
    const second = gate.start();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});
