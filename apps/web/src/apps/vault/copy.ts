/** Vault's standing sentences, in one place so the tests can hold them to the copy rules. */

/** What custody means, for a token lock. */
export const CUSTODY_TOKEN = "The tokens sit in a vault contract. Only the vault's owner can take them out, and only after the unlock date.";

/** What custody means, for a position lock. */
export const CUSTODY_POSITION =
  "The position sits in a vault contract. Only the vault's owner can take it out, and only after the unlock date. Until then the owner can still collect its trading fees.";

/** Under every state of the window. */
export const UNAUDITED = "Not audited yet. These vault contracts run on testnet until their audit is done.";

/** How a transfer of ownership works, under the Transfer form. */
export const TRANSFER_NOTE =
  "Ownership moves in two steps: the new owner accepts it in Vault. Until then you stay the owner, and you can cancel. Send them this vault's address.";

/** For a lock that was handed over, or a vault the wallet never had a part in. */
export const NOT_YOURS = "You don't own this vault, so you can only look.";
