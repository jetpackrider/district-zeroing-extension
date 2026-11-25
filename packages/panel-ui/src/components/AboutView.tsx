interface AboutViewProps {
  onClose: () => void;
}

export function AboutView({ onClose }: AboutViewProps) {
  return (
    <div className="zd-about" data-testid="about-view">
      <div className="zd-section-head">
        <h2>About Zero-Deviation Helper</h2>
        <button type="button" className="zd-btn zd-btn--sm" onClick={onClose}>
          ← Back
        </button>
      </div>

      <div className="zd-card">
        <h3>Read-only walkthrough</h3>
        <p>
          This extension reads your open Dave&apos;s Redistricting (DRA) map, finds connected census
          blocks along district borders that bring districts to zero deviation (0 or ±1 person
          depending on state remainder), and guides you while you paint them by hand. It never
          auto-paints or modifies your DRA map on its own.
        </p>
      </div>

      <div className="zd-card">
        <h3>Privacy</h3>
        <p>
          <strong>Your plan never leaves your browser.</strong> All district readings, block graph
          searches, and walkthrough checks run locally inside your browser. The only network
          requests made by the extension download static, public per-state census block data bundles
          cached locally for offline reuse.
        </p>
      </div>

      <div className="zd-card">
        <h3>Data attribution</h3>
        <ul>
          <li>
            <strong>Dave&apos;s Redistricting (DRA) data:</strong> Block population, prisoner-adjusted
            totals, and VTD/precinct adjacency data from{' '}
            <span className="zd-mono">dra2020/block_data</span> and{' '}
            <span className="zd-mono">dra2020/vtd_data</span> are used under the{' '}
            <strong>CC BY-SA 4.0</strong> license (free, not for sale). Derived data bundles are
            shared under the same license.
          </li>
          <li>
            <strong>U.S. Census Bureau data:</strong> 2020 TIGER/Line block shapes (TABBLOCK20) and
            2020 Block Assignment Files are in the <strong>public domain</strong>.
          </li>
        </ul>
      </div>
    </div>
  );
}
