import Link from "next/link";

/**
 * Every 404: an unknown URL, and a proof page for an address with no contract. Next's built-in page
 * colours itself from the OS setting; this one uses the theme's tokens, so it follows the choice
 * the boot script put on <html>.
 */
export default function NotFound() {
  return (
    <main className="mx-auto max-w-2xl p-6 text-sm">
      <p className="text-xs text-muted">4rc.OS</p>
      <h1 className="mt-1 text-xl font-medium">Page not found</h1>
      <p className="mt-2 text-muted">Check the address, or open the desktop.</p>
      <Link className="mt-6 inline-block rounded-md border border-border-2 px-3 py-1.5" href="/">
        Open 4rc.OS
      </Link>
    </main>
  );
}
