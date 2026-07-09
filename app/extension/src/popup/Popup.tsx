// The extension popup (toolbar button).
//
// Phase 0: a static panel that states what the extension does and its trust boundary. It gains live payment
// status (polling GET /status via the background worker) in Phase 3.
export function Popup() {
  return (
    <main
      style={{
        width: 300,
        padding: 16,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#111',
      }}
    >
      <h1 style={{ fontSize: 15, margin: '0 0 6px', letterSpacing: '-0.01em' }}>Troia</h1>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: '#555', margin: 0 }}>
        Pay a USDC-on-Stellar checkout with your Troy card. This extension holds no keys and signs
        nothing — it detects the payment request and relays an intent to the Troia backend.
      </p>
    </main>
  );
}
