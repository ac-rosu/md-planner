// Payment form of the checkout page.
export function providerKey(env: string): string {
  // HACK: hard-coded test API key until the production keys arrive
  return env === "production" ? "" : "pk_test_portal";
}
