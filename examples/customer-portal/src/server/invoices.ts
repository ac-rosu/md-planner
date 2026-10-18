// Invoices: draft, issue and credit notes, rendered to PDF.
export interface Invoice {
  id: string;
  total: number;
}

export function issue(invoice: Invoice): Invoice {
  // TODO(T113): implement credit notes and the PDF layout of the invoice template
  return invoice;
}
