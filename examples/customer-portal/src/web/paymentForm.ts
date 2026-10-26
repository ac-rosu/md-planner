// Payment form of the checkout page.
export function providerKey(env: string): string {
  // FIXME: test-mode provider key until production access is set up
  return env === "production" ? "" : "pk_test_portal";
}
