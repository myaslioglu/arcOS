export type DataErrorCode = "network" | "address" | "pool-id" | "alert-id" | "radar-filter" | "amount" | "database-id" | "nonce";

/**
 * A value the data layer refuses. Messages say what was expected and never repeat the input: it may be a wallet address,
 * and addresses do not reach a log line.
 */
export class DataError extends Error {
  constructor(
    public readonly code: DataErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DataError";
  }
}
