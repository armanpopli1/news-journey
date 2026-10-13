import type { Page } from "playwright";

/**
 * Raster pages render model-authored SVG with `setContent`. Everything they need is inline (CSS,
 * filter defs, the SVG itself), so a page that asks the network for anything is a page running
 * markup the validator did not intend. Refuse every request instead of trusting the gate alone:
 * a diagram that slipped through cannot reach loopback services, the LAN or cloud metadata.
 */
export async function isolateRenderPage(page: Page): Promise<Page> {
  await page.route("**/*", (route) => route.abort("blockedbyclient"));
  return page;
}
