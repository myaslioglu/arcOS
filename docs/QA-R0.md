# 4rc.OS R0 — manual QA script

For the project owner to run by hand: first on testnet, then again on mainnet once
`ARCOS.mainnet` is filled in (see `packages/contracts/DEPLOY.md`). Items marked **(no wallet
needed)** were already exercised against `npm run dev` while writing this script and behave as
described below. Everything else needs a browser wallet (any EIP-6963 extension — MetaMask,
Rabby, etc.; the WalletConnect section near the end covers phones) holding testnet USDC from
https://faucet.circle.com, and the contracts deployed per `packages/contracts/DEPLOY.md`, so it
is left for the owner to run once those two things exist.

Swap needs the same testnet wallet as the rest of this script. Bridge additionally needs that
wallet holding testnet USDC on an EVM testnet other than Arc (Ethereum Sepolia is the one used
below) — get it from https://faucet.circle.com or the relevant chain's own faucet — and, if you
want to see it charge a fee, `NEXT_PUBLIC_FEE_RECIPIENT` set to an address you can check the
balance of afterward. Both run against Circle's App Kit SDK in keyless mode (see the "Swap and
Bridge" section below for what to check, including the fee split).

## Desktop **(no wallet needed)**

1. Fresh browser tab, no wallet extension (or wallet disconnected): the desktop loads with four
   category trays — System, Trust, Create, Trade — each holding its real and coming-soon icons,
   and the dock pins Finder, Inspector, Mint, Drop, Swap, Wallet (Bridge and About are not
   pinned). Nothing overlaps the dock or the menu bar; a tray that runs past the bottom of the
   screen scrolls, it doesn't clip. Checked at 1280×800 and 1440×900.
2. Open Inspector, paste the testnet EURC address
   (`0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`), click Inspect. Expect: window title becomes
   "Inspector — EURC", 8 findings render, the badge reads "N of 8 checks pass" (never a numeric
   score), every finding with an evidence link resolves to `explorer.testnet.arc.io`. No wallet
   prompt at any point.
3. Open Mint (no wallet): shows "Connect a wallet to use this app." and an "Open Wallet" button,
   not a form.
4. Open Drop (no wallet): the same gate.
5. Load `http://localhost:3000/#app:inspector?token=0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`
   directly: Inspector opens on page load, pre-filled, and runs automatically — no click needed.

## Keyboard **(no wallet needed)**

6. Using a real keyboard in a normal browser tab — this couldn't be confirmed by the automated
   pass that checked the rest of this list, since its browser-driving tool has no way to send real
   keyboard focus/activation events — Tab steps through every desktop icon, dock tile, menu-bar
   item and window control, in a sensible order, and focus stays visible (a clear outline or ring)
   at every step, never invisible or just a subtle color change. Esc closes the active window.
   ⌘K (Ctrl+K on Windows/Linux) opens the launcher from anywhere. Enter and Space activate a
   focused tray icon and a focused dock tile — this last part is expected to work without
   needing to be exercised here, since both are native `<button>` elements and the browser gives
   them Enter/Space activation for free.

## Wallet

7. Connect: the Wallet window lists every EIP-6963 wallet the browser actually announces (not
   just a generic "Injected" entry) when more than one extension is installed. Approve in the
   extension; the window switches to the connected view (address link, network, balance,
   Disconnect).
8. Once connected on Arc Testnet, the menu bar's right side shows the short address and, within
   about 15 seconds, `· N USDC`.
9. Connect while the wallet is on a different chain: the menu bar reads "Switch to Arc Testnet"
   (underlined); clicking it, or the same button inside a gated app's "Your wallet is on another
   network." panel, prompts the wallet to add/switch networks and flips back to normal once it
   succeeds.
10. Disconnect from the Wallet window returns the menu bar to "Connect wallet".

## Inspector

11. Inspect a non-contract address (e.g. `0x0000000000000000000000000000000000000001`): renders
    "No contract at that address.", window title stays "Inspector".
12. Force the explorer unreachable for one inspection (or just run this from a server context on
    mainnet, which is documented as 403-ing non-browser clients): the affected findings read
    "unknown" — never guessed as pass or fail — and a banner reads "The explorer didn't answer, so
    some checks are marked unknown."
13. Click "Share proof page": the clipboard gets `http://<host>/t/<address>`. Open that link in a
    tab with JavaScript disabled — the page still renders (it's server-rendered), with the same
    findings, an "Open in 4rc.OS" link back to the app, and the disclaimer line.
14. Load `/badge/<address>` directly: the response is an `image/svg+xml` badge, not an app page.
15. Check the social card: fetching `/t/<address>` with a link-preview tool (or `curl -s
    .../t/<address> | grep -i og:image`) shows an `opengraph-image` that reflects the same token.
16. A mintable token you haven't renounced ownership of shows "Owner can mint new supply" under
    ownership/privileges. Call `renounceOwnership()` on that token (an EOA-owned `MintableToken`
    supports it, unlike `FeeController`), reinspect, and confirm the finding now reads ownership
    renounced / no privileged functions reachable.
17. Rate limit, per IP **(no wallet needed — already verified against `npm run dev`)**: 30 rapid
    requests to `/api/inspect/<address>` from one IP succeed (or 404/whatever the address resolves
    to); the 31st within the same minute returns `429` with a `retry-after` header. Confirmed
    locally: a loop of 35 requests returned `404` for the first 30 and `429` for the last 5, with
    `retry-after: 53` on the 429s.
18. Backpressure, per instance **(no wallet needed)**: this is a second, separate limiter from
    item 17 above — it caps concurrent *uncached* inspections across the whole server instance at
    8, regardless of which IP they come from, rather than capping requests per IP over a minute.
    Provoke it with a shell loop that fires more than 8 requests for different, real token
    addresses at once — e.g. about 20 distinct testnet token addresses in parallel — so more of
    them land while the gate is still full than a smaller batch would guarantee. Split them across
    two source IPs (or just keep each IP's share comfortably under 30 within that minute) so item
    17's per-IP limiter doesn't also fire and confuse the result: a `429` in the responses means
    you hit item 17's throttle instead, while a `503` with a `retry-after: 5` header means you hit
    this gate. Expect: once more than 8 uncached inspections are in flight at the same moment, the
    excess requests get `503`; loading the proof page (`/t/<address>`) for one of those addresses
    while the gate is saturated shows "4rc.OS is busy reading other tokens. Reload in a few
    seconds."; and `/badge/<address>` for a saturated address falls back to the neutral
    "4rc.OS: not inspected" grey badge rather than caching a broken result for five minutes.

## Mint

19. Create a fixed-supply token (e.g. name "Duke", symbol "DUKE", supply "1,000,000", decimals
    18, both checkboxes off): exactly one wallet prompt for the Mint fee (1 USDC on mainnet, 15 USDC on testnet) as native value, plus gas —
    confirm the requested value matches the fee shown on the submit button. After signing, the
    window shows "DUKE is live" with a working explorer link.
20. Create a token with 6 decimals (matching the ERC-20 USDC convention): the same flow works,
    and both Finder's balance and Inspector's report display it at the right scale — not off by
    factors of 10^12 against the 18-decimal fixed-supply case above.
21. Create a mintable token, no cap: Inspector shows "Owner can mint new supply"; the effective
    cap resolves to uncapped. With an explicit cap above supply, minting above it should revert
    (once a mint-more UI exists to try it).
22. Create a burnable token: the deployed contract is the burnable template — the holder can burn
    their own balance, there's no mint/owner function to find.
23. Click "Inspect it" on a freshly minted fixed-supply token: 8 findings, "No privileged
    functions found", "No owner function".

## Drop

24. Drag a real `.csv` file from the computer onto the Recipients textarea (not pasted text): its
    contents load into the list, a plain `address,amount` header row is recognized and skipped
    automatically, the row/total counts update.
25. Include a contract address with no `receive()` among the recipients of a native (USDC) drop:
    that row's value transfer fails and refunds to the sender; the result panel lists it under
    "N delivered" as a failed row reading "Line `<n>`: `<short address>`", where `<n>` is that
    row's actual line number in the pasted/CSV list — not its position within whichever batch it
    fell into.
26. Paste a list of more than 200 recipients: it splits into multiple `sendNative`/`sendToken`
    calls (200 per batch; the contract itself refuses more than 400 in one call, sized to Arc's
    30,000,000 block gas limit). The Send button's label steps through "Sending batch 1 of N…",
    "Sending batch 2 of N…", etc.
27. On a list that splits into 3 batches, reject the wallet prompt on batch 2: afterwards the
    textarea holds only the rows that never landed — batch 1's delivered rows are gone from the
    list, batch 2 and batch 3's rows remain — so pressing Send again resends only what's left, not
    the whole original list.
28. After a drop with failures, click "Copy failed rows", then paste the clipboard back into the
    textarea: the addresses and amounts match what was originally typed for those rows.
29. Check the fee line above Send: "Fee `<amount>` USDC · charged per recipient, including
    transfers that fail · `<n>` transaction(s)" — confirms the fee is charged per row submitted,
    not per row that actually lands.
30. Gas measurement on real hardware: send a real 200-recipient native drop on testnet, then read
    the transaction's `gasUsed` (`cast receipt <hash> --rpc-url arc_testnet` or the explorer) and
    compare it against the block gas limit (`cast block latest --rpc-url arc_testnet` →
    `gasLimit`, expected 30,000,000). This confirms the Foundry-measured "~14.1M gas for 400 fresh
    native recipients" the app's `BATCH = 200` sizing is based on (see
    `apps/web/src/apps/drop/parse.ts`) actually holds on the live network, not just in a local
    Anvil fork.
31. Known open question (from `packages/contracts/DEPLOY.md`): if a *recipient* (not the fee
    recipient) in a native drop is a blocklisted address on Arc, confirm whether only that row
    fails — the same skip-and-refund behavior as any other failing transfer — or whether the
    whole transaction reverts. This can only be checked on testnet against a real
    Circle-documented blocklisted test address, if one is published; it cannot be reproduced
    locally because the blocklist is an Arc network policy, not something Anvil enforces.

## Finder

32. With the wallet holding EURC (and ideally a self-created token), open Finder: EURC and any
    other ERC-20 holdings appear as files with their symbol; tokens created here appear first,
    newest first, each tagged "created by you"; the rest are sorted by symbol.
33. Drag a token file from Finder onto the Inspector tray icon, its dock tile, and an already-open
    Inspector window: each opens or updates a window titled "Inspector — `<symbol>`".
34. Select a token file and click "Send with Drop": opens Drop pre-filled with that token
    (skipping the USDC/Another-token picker).

## Proof page and badge, for a token minted here

35. Mint a token in this session, open its proof page (`/t/<address>`) and badge
    (`/badge/<address>`) using the flows above (Inspector's "Share proof page", or the URL
    directly): the proof page shows the token's own name/symbol and findings, and the badge SVG
    reflects the same check counts as the Inspector window.

## Swap and Bridge

Swap and Bridge call Circle's App Kit SDK without an API key (keyless mode), so both share one
public rate limit with the rest of the internet rather than a limit scoped to this app. A "busy"
response from the service is a real possibility, not a bug: Swap shows "The swap service is busy.
Try again in a minute." as the amount-box estimate error, and after clicking Swap it shows "The swap
service is busy, and the swap may still have gone through. Check your wallet's activity before trying
again in a minute." (the SDK also calls the service after the wallet sends), and Bridge shows the equivalent "The bridge service is busy. Try again in a minute." This can't be
reliably provoked on demand — it depends on the service's own load — so just confirm the message
text matches this if it happens to come up while running the rest of this section.

36. Open Swap with the wallet disconnected: the same "Connect a wallet to use this app." gate as
    every other trading app.
37. Connect, open Swap: pick USDC → EURC, type "1". Within about 400ms of the last keystroke an
    estimate appears — "You receive (estimated)" fills in, plus a "Minimum received" line, a "Max
    slippage 0.5%" line (1% instead once cirBTC is on either side of the pair), and any fee lines
    App Kit's estimate itself reports. Picking EURC as the "You send" token (matching what's
    already selected as "You receive") swaps the two instead of letting both read EURC; the "Flip"
    button does the same swap directly. If `NEXT_PUBLIC_FEE_RECIPIENT` is set, a single "Platform
    fee (0.20%)" line shows the estimate's own developer-fee amount (never a second, separate
    "0.20%" line duplicating it); if it's unset (or malformed), that line is absent entirely and no
    fee is charged — confirm both states by toggling the env var and restarting `npm run dev`. A
    fee entry whose amount comes back `null` reads "unknown", never silently disappears.
38. Type "1,5" into the amount box: no message appears, and within about 400ms the estimate is for
    1.5 (on live, "1,5" was refused). Clear it and type "1,500": `"1,500" could mean 1500 or 1.5. Write
    1500, or 1.5 with a dot.` appears and Swap is disabled. Clear it and type "1,500.25": no
    message, and the estimate is for 1500.25. Clear it and type a valid amount to confirm the
    message clears and Swap re-enables. Switch "You send" to cirBTC and type "0.12345678" (8
    decimal places): no error, Swap enables once the debounced estimate settles — cirBTC is
    validated at its own 8 decimal places, not USDC/EURC's 6. Switch back to USDC and try the same
    8-decimal text: refused, since USDC only allows 6.
39. Type an amount, then edit it again inside the 400ms debounce window (before the estimate
    updates): the button immediately reads "Updating the quote…" and is disabled — it does not stay
    enabled against the stale estimate from before the edit. Confirm the amount that actually
    swaps, when you do click Swap, is always what the box shows at the moment of the click, never a
    debounced value that lagged behind it.
40. Click Swap: one or two wallet prompts (App Kit handles any allowance itself — permit signature
    or an approve transaction — before the swap transaction). While it's in flight the button reads
    "Waiting for your wallet…" and the form is locked; a second click, or opening a second Swap
    window, does nothing until this one finishes, and shows "Swapping `<amount>` `<tokenIn>` →
    `<tokenOut>`…". Once it lands: only a `DONE` status shows "Swap complete" (success styling, the
    transaction link, and the received amount if App Kit's result reports one); a `FAILED` or
    `NOT_FOUND` status shows a warning-styled reason (the SDK's own explanation) and never claims
    success; anything else (still in-flight) shows a neutral "Swap submitted — check the
    transaction" with the link. If `NEXT_PUBLIC_FEE_RECIPIENT` was set, check that address's
    **EURC** balance (the output token of this USDC → EURC swap — the custom fee on a same-chain
    swap is taken from what the recipient receives, not from USDC) increased by about 0.0016 EURC
    on a 1 USDC swap (0.20% of the EURC received, minus Circle's 10% share of that custom fee —
    i.e. `NEXT_PUBLIC_FEE_RECIPIENT` keeps 90% of it).
41. Close the Swap window mid-swap (right after clicking Swap, before it resolves) and reopen it:
    "Swapping `<amount>` `<tokenIn>` → `<tokenOut>`…" is there — or the result, once it lands — not
    a blank form. This is the session store surviving the window unmounting, the same pattern Drop
    uses.
42. Open Bridge with the wallet disconnected: the same connect gate.
43. Connect, open Bridge: "To Arc" is selected by default, "From" defaults to the first EVM chain
    in the list (Ethereum Sepolia on testnet). Check the chain select lists exactly six EVM chains
    (no Solana) matching the active network (mainnet or testnet, never a mix). Type "1" in Amount:
    "Fee 0.002 USDC (0.20%) · added on top" appears when `NEXT_PUBLIC_FEE_RECIPIENT` is set, absent
    when it isn't.
44. Click Bridge with the wallet on Arc Testnet and "To Arc" / Ethereum Sepolia selected: the
    wallet is prompted to switch to Ethereum Sepolia (App Kit's adapter drives this itself), then
    to approve/burn there; depending on whether Circle's Forwarder relays the mint, either no
    further prompt is needed or the wallet is asked to switch back to Arc Testnet for one more
    signature. This can take a few minutes — the window says so and stays usable. Once it
    settles: any `warnings` App Kit's result reports (e.g. a FAST→SLOW speed downgrade) are listed
    as plain lines, then each step (its name, state, and — where present — a transaction hash
    linking to that chain's own explorer) below them, and the headline reads "Bridge complete",
    "Still finishing on the destination chain", or "The bridge stopped before finishing" depending
    on the result's `state` — never a guessed "complete" the SDK didn't actually report. If
    `NEXT_PUBLIC_FEE_RECIPIENT` was set, confirm that address's USDC balance on Ethereum Sepolia
    (the source chain — bridge fees are charged there, added on top of the transfer) increased by
    about 0.0018 USDC.
45. A failed bridge (`state: 'error'`) where the burn already landed on the source chain shows
    "Your USDC left `<source>`. It isn't lost: it can still be delivered on `<dest>`." above the
    step list; a failure before the burn ever succeeded doesn't show that sentence, since nothing
    left the wallet. When the failed step's error is one App Kit's `isRetryableError` considers
    retryable, a "Retry" button appears and calls App Kit's `retryBridge` through the same
    one-at-a-time session guard as the original submit; the failed result (and the Retry option)
    survive closing and reopening the Bridge window, same as item 46 below. This is hard to provoke
    on demand against a real network — the fake-kit browser check in the implementer's report is
    the practical way to see this rendered; treat this item as confirmed once that's been done and
    spot-check it again if a real bridge happens to fail during testnet QA.
46. Close the Bridge window mid-transfer and reopen it (or open a fresh Bridge window): the
    in-flight state, or the settled result, is still there — closing the window never orphans a
    transfer that already burned funds on the source chain. Closing or reloading the tab itself
    prompts the browser's native "leave site?" warning while a bridge is in flight.
47. Known simplification, not a bug: Bridge shows live progress only as "Bridging — this can take
    a few minutes" while the SDK's single `kit.bridge()` call is in flight, then the full step list
    once it settles — it does not subscribe to App Kit's per-step event stream for a live
    approve/burn/attest/mint ticker.

## Phone width

48. At about 390px wide with touch emulation: the desktop becomes a single searchable list of
    every app grouped by the same four categories; tapping an app opens it full screen; the
    minimize (–) control returns to the list; Inspector's, Mint's, Drop's, Swap's and Bridge's
    forms fit the width with no horizontal scrolling. (Verified for Inspector as shipped, and for
    Mint, Drop, Swap and Bridge with their wallet/deployment gates temporarily bypassed locally
    and reverted.)

## Final fix wave G

49. Drop, "Another token" with an unresolved address: pick "Another token", leave the address
    field empty, and paste a few valid recipient rows. Expect: Send reads "Enter the token's
    address first." and is disabled — the row/total preview never falls back to treating the list
    as native USDC. Start typing a real ERC-20 address: once it's a syntactically valid address
    the label changes to "Reading the token…" (still disabled) until its symbol/decimals resolve;
    only then does Send enable and show the real token's symbol in the total. At no point during
    this should the app be sendable as, or quote, native USDC.
50. Drop, the unconfirmed-batch panel: send a list of at least one batch, and right after approving
    the transaction in the wallet extension (before its receipt can be read) cut network access —
    turn off Wi-Fi, or use the browser devtools' "offline" throttling — so the confirmation never
    comes back. Expect: the result panel shows a "This batch was sent but not confirmed" section
    with that batch's own rows (not the whole original list) and an explorer link for that batch's
    own transaction hash, plus a "Copy these rows" button. Click "It landed — I checked": the
    section disappears and those rows are NOT added back to the textarea. Repeat the drop and this
    time click "It didn't land — put these rows back in the list": the rows ARE appended to the
    textarea, ready to resend; close and reopen the Drop window before clicking either button and
    confirm the section is still there; clicking either button again afterward does nothing further
    (the rows never duplicate in the list).
51. Mint and Drop refuse a network switch before the wallet opens: connect on Arc Testnet, open
    Mint (or Drop) and fill in valid parameters, then switch the wallet extension to a different
    network WITHOUT reloading the page or window. Click Create token (or Send): the app shows "Your
    wallet is on a different network. Switch to Arc and try again." and no wallet prompt ever
    appears. For Drop specifically, paste a list long enough to span at least two batches, let batch
    1 send successfully, then switch networks before approving batch 2: batch 2 is refused the same
    way (checked live, not just once at the start of the whole send) rather than being signed on the
    wrong chain.

## Fix round 1

52. Drop, an ambiguous amount blocks the whole list: paste
    ```
    0x1111111111111111111111111111111111111111,1
    0x2222222222222222222222222222222222222222,100,1
    ```
    (the second row's amount, "100,1", is a lone comma right after a comma-separated address — it
    could be a decimal comma or a third column, and the row can't tell which). Expect: "Some
    amounts could be read two ways (line 2). Fix those rows before sending." appears above the
    issues list, naming that row's own line number, the second row shows excluded with `In a
    comma-separated list, write amounts without a comma (1500, or 1.5), or separate the columns
    with a semicolon or a tab.`, and Send is disabled even though the first row is fine on its own.
    Retype the second row's amount as "100.1" (or move it after a semicolon, e.g.
    "0x2222…;100,1"): the banner and the disabled Send both clear. Separately, a row like
    "0x3333…;1,500" (a semicolon separator, three digits after the comma, no leading zero) blocks
    Send the same way, through the parser's own ambiguous message rather than the comma-column one.
    Also try "0x4444… , 1,5" (a space then a comma — the textarea's own placeholder style, "0x… ,
    12.5"): refused the same as a plain comma row, not read as 1.5.
53. Mint, the supply/cap echo: type "100.000" into the Initial supply field — "= 100 DUKE" (or
    whatever symbol is set) appears under the field, confirming what will actually be minted is 100,
    not a hundred thousand. Type "1,5" instead: the echo reads "= 1.5 DUKE". Clear the field, or
    type something that doesn't parse (e.g. "abc" or "100,000", which is ambiguous): the echo
    disappears. With "I can mint more later" checked, repeat for the Maximum supply field. Then
    click Create with the supply empty: an error appears under the field. Without clicking Create
    again, type "100.000" into the supply field: the error clears immediately and "= 100 DUKE"
    shows right away, not just after another click (RI2 — a stale error used to hide the echo until
    the next submit).

## Revoke

54. Open Revoke with no wallet connected. Expect an "Address to look up" field with a "Look" button, the sentence
    "Connect a wallet, or paste an address to look." with an "Open Wallet" button under it, and at the bottom "Token
    approvals only. NFT and Permit2 approvals come later." Type `nope` and click Look: `That isn't an address.` appears
    under the field.
55. Paste the address of a wallet that has approved a token and click Look. Expect "Loading approvals…", then
    `Viewing 0x12…ab. Only its own wallet can revoke.` above one row for each live approval: the token as
    `SYMBOL · 0x12…ab` over its name, the allowance ("Unlimited", or the amount at the token's decimals), and "Spender:"
    with the spender's name (Permit2, for one) or "Unknown contract", plus its short address. A spender with no name has
    an "Inspect" button that opens Inspector on it. There are no Revoke buttons. A wallet with none reads "No active token
    approvals." A list that can't be read says "Couldn't load approvals. Try again in a minute." with a "Try again"
    button, and one that was cut short says "This list may be incomplete: some approvals couldn't be read."
56. Connect a wallet on Arc that has an approval to spare (for a test, the allowance a Drop leaves when its second batch
    is rejected, item 27), and open Revoke, or click "My wallet". The list is the wallet's own, with no "Viewing" line and
    a "Revoke" button on each row. Click one: the button reads "Waiting for your wallet…", every Revoke button is
    disabled, and the wallet shows one transaction, `approve(spender, 0)` on that token, of no value. Confirm it. Expect
    the row to disappear and, if focus was lost, keyboard focus on the next row's Revoke button (on the list itself when
    none is left). A reload of the tab doesn't bring the row back.
57. Refuse a revoke in the wallet: the row stays, `You cancelled the request in your wallet.` appears under it, and its
    button works again. With the wallet on another network Revoke shows "Your wallet is on another network." and a
    "Switch to Arc" button ("Switch to Arc Testnet" on testnet) in place of the list, and nothing is sent.

## Terminal

58. Open Terminal (in the System tray, or search for it with Ctrl K). Expect `4rc.OS terminal. Type help for the
    commands.`, the prompt `4rc:~$` with a field showing `help` as its placeholder, and the hint "Tab completes · ↑
    history · Ctrl L clears" (shown in capitals). Type `help`: one line for each of the 13 commands, with what it does: `help`, `open [app]`,
    `inspect <address>`, `approvals [address]`, `balance [address]`, `block`, `gas`, `whoami`, `theme light|dark|system`,
    `roadmap`, `clear`, `history` and `about`. Type `nosuchcommand`: `Unknown command: nosuchcommand. Type help.`
59. It reads the chain, with no wallet needed. `block` answers `Block <number> · <n> s ago · <n> transactions`. `gas`
    answers `Base fee: <n> gwei` and what a plain USDC transfer costs at it. `balance <address>` answers `0x12…ab: <n>
    USDC` as a link to that address on the explorer. `balance` alone, with no wallet connected, answers `No wallet
    connected. Try balance <address>.` `whoami` answers `No wallet connected`, or the connected address and `On Arc`
    (`On Arc Testnet` on testnet).
60. It opens apps. `open` lists every app id, with "(work in progress)" beside the grey ones. `open swap` opens Swap and
    answers `Opened Swap.` `inspect <token address>` opens Inspector on it, `approvals` opens Revoke for the connected
    wallet (`approvals <address>` for another), and `roadmap` lists the apps on the way with their stages. `theme dark`
    answers `Theme set to dark.` and changes the theme (`theme system` follows the device again). Tab completes a command
    or an app id, ↑ and ↓ walk this window's history, and Ctrl L clears the screen.
61. It never signs or sends anything. Connect a wallet, run every command above once, and confirm the wallet opens no
    prompt for any of them.

## WalletConnect (phone wallets)

Needs `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (set for https://4rcos.com in `apps/web/apphosting.yaml`) and a phone with
a wallet that speaks WalletConnect (Trust Wallet, MetaMask or Binance Wallet). The domain allowlist in the Reown
dashboard limits where that project ID works, so test on https://4rcos.com, not on localhost.

62. On a phone, or in a desktop browser with no wallet extension, open Wallet. Expect one button, "WalletConnect (phone
    wallets)"; with a browser wallet installed it is the last button, below that wallet's own. Reload the page and look
    at the browser's network panel: nothing goes to walletconnect.org or web3modal.org until the button is clicked.
63. Click it. Expect "Waiting for your wallet…" and WalletConnect's modal, with a QR code ("Scan this QR Code with your
    phone"), "Copy link" and the wallet list. Choose your wallet and approve the connection in it. The modal closes and
    the Wallet window shows "WalletConnect", the address, the network ("Arc") and the balance, with a "Disconnect"
    button. Run one paid action (a Revoke costs the least): the request reaches the phone, is signed there, and the app
    shows the result as it does for a browser wallet.
64. Open the modal again and close it before a wallet answers, with its ✕ or with Escape: `You cancelled the request in
    your wallet.` appears in the Wallet window, and the window itself stays open (Escape closed the modal first).
65. While connected, reload the page: the session comes back with no click. Click "Disconnect" and reload: the network
    panel shows no request to walletconnect.org, so a session that has ended costs nothing more. If the WalletConnect
    code can't load (offline, or a page left open across a deploy) the Wallet window says `WalletConnect couldn't load.
    Reload the page and try again.`

## Before mainnet — gate list

This list is the pre-launch record: mainnet went live on 2026-09-25, and a box is ticked only where the repository
shows it was done.

- [ ] Every testnet item above passes.
- [ ] `ARCOS_FEE_RECIPIENT` is a plain payable address — an EOA, or a multisig whose
      `receive()`/fallback can't revert.
- [ ] `FeeController`'s owner is a wallet you can't lose. Renouncing is disabled by design (it's
      the only recovery lever if the fee recipient ever stops accepting value), so there is no
      way to recover a lost owner key.
- [x] `NEXT_PUBLIC_ARC_NETWORK=mainnet` is set only after `ARCOS.mainnet` in
      `packages/chain/src/addresses.ts` is filled in with the real deployed addresses. (On 2026-09-25 the commit that
      wired the addresses came four minutes before the one that set mainnet in `apps/web/apphosting.yaml`.)
- [ ] GitHub private vulnerability reporting is enabled in the repository settings.
- [x] The About window and README state the contracts are unaudited. (The About window: "These contracts haven't been
      audited by a third party." The README: "The contracts are unaudited.")
