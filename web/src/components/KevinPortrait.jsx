// The mascot slot. The build checks for web/public/kevin.png; without it, a drawn badge stands in
// so the masthead still looks finished (and no request 404s).
export function KevinPortrait() {
  if (__HAS_MASCOT__) {
    return (
      <figure className="portrait">
        <img src="./kevin.png" width="512" height="512" alt="Kevin from IT, holding a coffee and a printed ticket" />
        <figcaption className="portrait-badge">
          <span>KEVIN</span>
          <span>IT / ON CALL</span>
        </figcaption>
      </figure>
    );
  }
  return (
    <figure className="portrait portrait-drawn" aria-hidden="true">
      <svg viewBox="0 0 120 120" role="presentation">
        <rect x="18" y="10" width="84" height="100" rx="6" fill="none" stroke="currentColor" strokeWidth="4" />
        <rect x="46" y="4" width="28" height="12" rx="3" fill="currentColor" />
        <path d="M44 38v44M44 60l24-22M52 54l18 28" stroke="#c24d0c" strokeWidth="9" fill="none" strokeLinecap="square" />
        <path d="M30 96h60" stroke="currentColor" strokeWidth="3" strokeDasharray="4 4" />
      </svg>
    </figure>
  );
}
