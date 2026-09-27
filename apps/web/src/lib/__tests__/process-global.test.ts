import { afterEach, describe, expect, it, vi } from "vitest";
import { processGlobal } from "../process-global";

describe("processGlobal", () => {
  const name = `test.${Math.random()}`;
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(`arcos.${name}`)];
  });

  it("creates a value once per process, whichever copy of a module asks first", () => {
    const create = vi.fn(() => ({ budget: 8 }));
    const first = processGlobal(name, create);
    const second = processGlobal(name, create); // another module copy asking for the same thing
    expect(second).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps it on globalThis under a Symbol.for key, where every chunk of the bundle finds it", () => {
    const value = processGlobal(name, () => ({ budget: 8 }));
    expect((globalThis as Record<symbol, unknown>)[Symbol.for(`arcos.${name}`)]).toBe(value);
  });

  it("keeps different names apart", () => {
    expect(processGlobal(name, () => ({ a: 1 }))).not.toBe(processGlobal(`${name}.other`, () => ({ a: 1 })));
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(`arcos.${name}.other`)];
  });
});
