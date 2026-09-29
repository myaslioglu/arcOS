import { expect } from "vitest";
import { DataError } from "../../errors";

/** What a call refused with; fails the test when it throws anything but a DataError, or does not throw. */
export function refusal(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DataError);
    return { code: (error as DataError).code, message: (error as DataError).message };
  }
  throw new Error("expected the call to throw");
}
