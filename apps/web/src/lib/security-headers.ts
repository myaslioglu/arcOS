import { CHAINS } from "@arcos/chain";

/**
 * The security headers of every response, as data: this module imports nothing from Next, so it is unit-tested, and
 * next.config.ts only hands its two sets to `headers()`.
 *
 * Two sets, both on every path:
 *
 * - `enforcedHeaders()`: enforced from the first request. Its content security policy holds only the four directives
 *   that can't stop a wallet, Swap or Bridge flow (no framing, no plugins, no <base>, forms only to this site).
 * - `reportOnlyHeaders()`: the full policy, as `Content-Security-Policy-Report-Only`, with the site's own report
 *   endpoint (app/api/csp-report). It blocks nothing. It watches what real visitors' pages load and call, so the hosts
 *   below can be corrected before the whole policy is enforced, in a later step.
 */

export type Header = { key: string; value: string };

/** Where the browser posts violation reports: app/api/csp-report/route.ts. */
export const CSP_REPORT_PATH = "/api/csp-report";

/**
 * What is enforced: the directives that cannot break a flow. `frame-ancestors` is the reason it exists: the windows that
 * ask a wallet to sign must not be framed by another site. `X-Frame-Options` says the same for browsers that predate it.
 */
const ENFORCED_CSP = "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";

export function enforcedHeaders(): Header[] {
  return [
    // Two years, subdomains too. No `preload`: that is a promise to browsers' built-in lists, which is hard to take back.
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), browsing-topics=()" },
    // Not `same-origin`: that cuts the link to a window this page opened, which a wallet's popup may need.
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
    { key: "Content-Security-Policy", value: ENFORCED_CSP },
  ];
}

const originOf = (url: string): string => new URL(url).origin;
const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

/**
 * Arc's RPC nodes, https and wss, for both networks. The source is `CHAINS` in @arcos/chain, the list the app's own
 * clients read; the browser's wagmi clients call these (Inspector, Mint, Drop, Revoke, Terminal, the wallet's balance).
 */
function arcRpcOrigins(): string[] {
  return unique(
    Object.values(CHAINS).flatMap((chain) =>
      [...chain.rpcUrls.default.http, ...(chain.rpcUrls.default.webSocket ?? [])].map(originOf),
    ),
  );
}

/**
 * The explorers' APIs, from `CHAINS` too. Finder (a wallet's token balances) and the Inspector window read them from the
 * page itself; the server's own reads, which use Blockscout's PRO API, are not the browser's.
 */
function arcExplorerOrigins(): string[] {
  return unique(
    Object.values(CHAINS).flatMap((chain) => {
      const apiUrl = chain.blockExplorers?.default.apiUrl;
      return apiUrl ? [originOf(apiUrl)] : [];
    }),
  );
}

/**
 * WalletConnect and Reown, which load only when a visitor picks WalletConnect (providers/lazyWalletConnect.ts). Found by
 * reading @walletconnect/core, @walletconnect/universal-provider, @reown/appkit and its controllers as installed.
 */
const WALLETCONNECT_CONNECT = [
  "wss://relay.walletconnect.org", // @walletconnect/core's relay: the encrypted session between this page and the phone
  "https://pulse.walletconnect.org", // @walletconnect/core's event client, and @reown/appkit's usage events
  "https://api.web3modal.org", // @reown/appkit's modal: the wallet list, each wallet's icon and the project's configuration
  "https://rpc.walletconnect.org", // (unverified) @walletconnect/universal-provider's RPC for a chain it has no URL for; wagmi gives it Arc's
];

/** The one page WalletConnect's client frames, out of sight: its check of this site against the Verify API. */
const WALLETCONNECT_FRAMES = [
  "https://verify.walletconnect.org", // @walletconnect/core's Verify, on each session or signing request it sends
];

/** @reown/appkit-ui's stylesheet, which the modal adds to the page, imports Inter from Google Fonts. */
const MODAL_STYLE_HOSTS = ["https://fonts.googleapis.com"]; // the @import in @reown/appkit-ui's ThemeUtil
const MODAL_FONT_HOSTS = ["https://fonts.gstatic.com"]; // the font files that stylesheet names

/**
 * Circle's App Kit, behind Swap and Bridge (keyless mode). Found by reading @circle-fin/app-kit, its providers and
 * @circle-fin/adapter-viem-v2 as installed. Its viem adapter reads each chain through the RPC endpoints of the chain
 * definitions in @circle-fin/app-kit/chains, so the list below is those of the chains Bridge offers (apps/bridge/chains.ts);
 * security-headers.test.ts fails if a newer App Kit names another.
 */
const CIRCLE_CONNECT = [
  "https://api.circle.com", // App Kit: Swap's quote, swap and status service, and the kits' own event log (Swap, Bridge)
  "https://iris-api.circle.com", // App Kit Bridge (CCTP): attestations and burn fees, mainnet chains
  "https://iris-api-sandbox.circle.com", // App Kit Bridge (CCTP): the same for testnets
  // Chains Bridge offers on mainnet. Arc's own node, rpc.mainnet.arc.io, is in the list from @arcos/chain above.
  "https://ethereum-rpc.publicnode.com", // App Kit's adapter: Ethereum
  "https://ethereum.publicnode.com", // App Kit's adapter: Ethereum, second endpoint
  "https://mainnet.base.org", // App Kit's adapter: Base
  "https://base.publicnode.com", // App Kit's adapter: Base, second endpoint
  "https://arb1.arbitrum.io", // App Kit's adapter: Arbitrum
  "https://mainnet.optimism.io", // App Kit's adapter: Optimism
  "https://polygon.publicnode.com", // App Kit's adapter: Polygon
  "https://polygon.drpc.org", // App Kit's adapter: Polygon, second endpoint
  "https://api.avax.network", // App Kit's adapter: Avalanche
  // The same on testnet. App Kit's own definition of Arc Testnet still names the pre-launch host.
  "https://rpc.testnet.arc.network", // App Kit's adapter: Arc Testnet
  "https://ethereum-sepolia-rpc.publicnode.com", // App Kit's adapter: Ethereum Sepolia
  "https://sepolia.base.org", // App Kit's adapter: Base Sepolia
  "https://sepolia-rollup.arbitrum.io", // App Kit's adapter: Arbitrum Sepolia
  "https://sepolia.optimism.io", // App Kit's adapter: Optimism Sepolia
  "https://polygon-amoy-bor-rpc.publicnode.com", // App Kit's adapter: Polygon Amoy
  "https://polygon-amoy.drpc.org", // App Kit's adapter: Polygon Amoy, second endpoint
  "https://api.avax-test.network", // App Kit's adapter: Avalanche Fuji
];

type Directive = readonly [name: string, sources: readonly string[]];

/**
 * The full policy, in the order it reads best.
 *
 * `script-src` allows 'unsafe-inline' because Next's own bootstrap scripts (the inline ones that carry the page's data)
 * and the theme script in app/layout.tsx are inline and carry no nonce. A nonce would have to be made for every request,
 * which makes every page render on the server on each visit instead of being served as a static file. The scripts that
 * do load are all from this site, so `script-src 'self'` still keeps every other host's script out.
 *
 * `dev` adds 'unsafe-eval', which React's development build needs to rebuild server errors in the browser (the Next guide
 * says so); a production build doesn't.
 *
 * There is no `upgrade-insecure-requests`, here or in the enforced policy. A report-only policy ignores it, and Chromium
 * logs a console error about that on every page. Enforced, it isn't needed: HSTS already keeps every visit on https and
 * every source above is https:, wss:, data: or blob:. It would also break a local `next start` served over http from a LAN
 * address, whose own requests would be rewritten to https, which that server doesn't speak.
 */
export function reportOnlyPolicy({ dev = false }: { dev?: boolean } = {}): string {
  const directives: Directive[] = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])]],
    ["style-src", ["'self'", "'unsafe-inline'", ...MODAL_STYLE_HOSTS]],
    ["img-src", ["'self'", "data:", "blob:", "https:"]],
    ["font-src", ["'self'", "data:", ...MODAL_FONT_HOSTS]],
    [
      "connect-src",
      unique(["'self'", ...arcRpcOrigins(), ...arcExplorerOrigins(), ...WALLETCONNECT_CONNECT, ...CIRCLE_CONNECT]),
    ],
    ["frame-src", WALLETCONNECT_FRAMES],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
    ["report-uri", [CSP_REPORT_PATH]],
    ["report-to", ["csp"]],
  ];
  return directives.map(([name, sources]) => [name, ...sources].join(" ")).join("; ");
}

export function reportOnlyHeaders(options: { dev?: boolean } = {}): Header[] {
  return [
    { key: "Content-Security-Policy-Report-Only", value: reportOnlyPolicy(options) },
    // The group name `report-to csp` in the policy refers to.
    { key: "Reporting-Endpoints", value: `csp="${CSP_REPORT_PATH}"` },
  ];
}
