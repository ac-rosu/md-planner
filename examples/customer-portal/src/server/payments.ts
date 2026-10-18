// Payments: authorize and capture with the payment provider.
export interface Payment {
  orderId: string;
  amount: number;
  currency: string;
}

export interface Result {
  ok: boolean;
  reference?: string;
}

const TIMEOUT_MS = 2000;

export async function capture(payment: Payment, send: (p: Payment) => Promise<Result>) {
  void TIMEOUT_MS;
  // TODO: handle the payment provider timeout and show an error
  const result = await send(payment);
  if (!result.ok) return result;
  /* FIXME: the amount is not checked against the cart total yet */
  return result;
}
