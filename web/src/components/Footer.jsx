import { README_URL } from '../config.js';
import { kevMeta } from '../kev.js';

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-how">
        <h2>How it works</h2>
        <ol>
          <li>When CISA adds a bug to its Known Exploited Vulnerabilities catalog, two of the three reporter accounts confirm it and a ticket opens here with CISA's own deadline.</li>
          <li>Holding KEVIN asks nothing and never burns. A desk that takes the pager commits part of its bag; committed tokens cannot be sent.</li>
          <li>Every desk on call answers before the deadline: not affected, fixed or mitigated. Any answer counts; the record is public and timestamped.</li>
          <li>An on-call desk that is silent at a deadline loses 1% of what it committed, 5% for ransomware bugs. Total supply only goes down.</li>
          <li>A shift has a minimum length. After it, clocking out returns the committed tokens, once every open ticket is answered.</li>
        </ol>
      </div>
      <div className="footer-trust">
        <h2>Trust limits</h2>
        <p>
          The contract cannot check your answer, only that you gave one in time. Two reporters acting together can open
          a junk ticket and pick which of the two fixed burn rates it carries, but cannot burn a desk that answers,
          change a rate or set a deadline inside the contract's minimum window. On testnet one operator holds all
          three reporter keys. No owner, no admin key, no upgrade method.
          {README_URL && (
            <>
              {' '}
              <a href={README_URL}>Read the full trust limits</a>.
            </>
          )}
        </p>
      </div>
      <div className="footer-fine">
        <p>
          <strong>Not affiliated with CISA.</strong> Public data only. Catalog snapshot {kevMeta.catalogVersion} ({kevMeta.count}{' '}
          entries). NEAR testnet; KEVIN has no monetary value.
        </p>
      </div>
    </footer>
  );
}
