// On-call triage: decide, per open ticket, whether the bot may answer `not_affected` or must page a human.
// Pure, so it is tested with fixtures. The rule is deliberately one-sided: a bot only ever claims "we do
// not run this"; anything that matches the inventory waits for a person.

/**
 * Only an on-call desk may answer (close_ticket panics otherwise). Returns the line to print and stop on when the
 * desk from get_desk is not on call, or null when the bot may go ahead.
 */
export function notOnCallLine(desk, accountId, contractId) {
  return desk?.on_call === true ? null : `${accountId} is not on call on ${contractId}: go_on_call first`;
}

/** Validate and normalize inventory JSON: an array of { vendor, product? } case-insensitive substrings. */
export function parseInventory(json) {
  const list = Array.isArray(json) ? json : json?.inventory;
  if (!Array.isArray(list)) throw new Error('inventory must be a JSON array of {vendor, product?}');
  return list.map((item, i) => {
    const vendor = typeof item?.vendor === 'string' ? item.vendor.trim() : '';
    if (!vendor) throw new Error(`inventory[${i}]: vendor must be a non-empty string`);
    if (item.product !== undefined && (typeof item.product !== 'string' || !item.product.trim())) {
      throw new Error(`inventory[${i}]: product, when given, must be a non-empty string`);
    }
    return { vendor: vendor.toLowerCase(), product: item.product?.trim().toLowerCase(), raw: item };
  });
}

/** The first inventory pattern that matches the ticket's vendor (and product, when the pattern has one). */
export function matchInventory(ticket, inventory) {
  const vendor = String(ticket.vendor ?? '').toLowerCase();
  const product = String(ticket.product ?? '').toLowerCase();
  return inventory.find((p) => vendor.includes(p.vendor) && (!p.product || product.includes(p.product))) ?? null;
}

/**
 * tickets: open tickets from get_open_tickets. statements: the account's get_statements result for the
 * same ids, in the same order. Returns [{ ticket, action: 'close' | 'page' | 'skip', reason, match }].
 */
export function triage({ tickets, statements, inventory, nowMs }) {
  return tickets.map((ticket, i) => {
    if (statements?.[i]) return { ticket, action: 'skip', reason: `already answered ${statements[i].status}`, match: null };
    if (ticket.state !== 'open' || nowMs >= Number(ticket.deadline_ms)) {
      return { ticket, action: 'skip', reason: 'deadline passed', match: null };
    }
    const match = matchInventory(ticket, inventory);
    if (match) return { ticket, action: 'page', reason: `inventory match ${match.raw.vendor}${match.raw.product ? ` / ${match.raw.product}` : ''}`, match };
    return { ticket, action: 'close', reason: 'no inventory match', match: null };
  });
}

/** The PAGE line a human reads: CVE, product, deadline and CISA's required action. */
export function pageLine(ticket, requiredAction) {
  const deadline = new Date(Number(ticket.deadline_ms)).toISOString();
  const action = requiredAction || 'see https://www.cisa.gov/known-exploited-vulnerabilities-catalog';
  const tag = ticket.ransomware ? ' [RANSOMWARE]' : '';
  return `PAGE ${ticket.cve_id}${tag} ${ticket.vendor} ${ticket.product} | deadline ${deadline} | ticket #${ticket.id} | CISA: ${action}`;
}
