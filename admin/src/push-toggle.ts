/**
 * admin/src/push-toggle.ts
 * The push-notification toggle fragment spliced into the chat thread page.
 *
 * SINGLE EARLY GATE (acceptance criterion 6): when push is disabled server-side
 * (VAPID not fully configured → no public key threaded here), this returns "" —
 * so the thread page degrades to EXACTLY the CFB-3.2 page with no toggle and no
 * partial remnants. Client-side unsupported/denied states are handled inside
 * the fragment's own script, which keeps the button hidden or shows static
 * guidance rather than a broken control.
 *
 * The client script (acceptance criterion 5):
 *   - Requests Notification permission ONLY inside the button's click handler,
 *     never on load.
 *   - If permission is already 'denied', it NEVER calls requestPermission()
 *     again — it shows static "enable in browser settings" guidance instead.
 *   - On iOS Safari that is NOT standalone, PushManager is undefined not
 *     because push is unsupported but because the app isn't installed — so it
 *     shows "Add to Home Screen" education, not an error (iOS honesty).
 *   - Subscribes via navigator.serviceWorker.ready → pushManager.subscribe.
 */

export interface PushToggleArgs {
  pushEnabled: boolean;
  vapidPublicKey: string;
  agentId: string;
  threadId: string;
}

export function renderPushToggle(args: PushToggleArgs): string {
  // The single early gate. No public key (partial/absent VAPID) → no toggle.
  if (!args.pushEnabled || !args.vapidPublicKey) return "";

  const subscribeUrl = `/admin/chat/${encodeURIComponent(
    args.agentId,
  )}/push/subscribe`;
  const unsubscribeUrl = `/admin/chat/${encodeURIComponent(
    args.agentId,
  )}/push/unsubscribe`;

  return `
<div class="push-toggle" id="push-toggle" style="margin:8px 0;font-size:13px">
  <button type="button" id="push-toggle-btn" class="btn btn-secondary" style="display:none">Enable notifications</button>
  <span id="push-toggle-status" style="color:#6b7280"></span>
</div>
<script>
(function() {
  var VAPID_PUBLIC_KEY = ${JSON.stringify(args.vapidPublicKey)};
  var SUBSCRIBE_URL = ${JSON.stringify(subscribeUrl)};
  var UNSUBSCRIBE_URL = ${JSON.stringify(unsubscribeUrl)};
  var btn = document.getElementById('push-toggle-btn');
  var status = document.getElementById('push-toggle-status');
  if (!btn || !status) return;

  function setStatus(text) { status.textContent = text; }

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  var isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  var isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;

  // iOS honesty: PushManager is undefined in a Safari TAB but defined in an
  // installed Home Screen app. Do NOT conflate 'unsupported' with 'not yet
  // installed' — on iOS-and-not-standalone show install education, not an error.
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    if (isIOS && !isStandalone) {
      setStatus('To get notifications, use Share → Add to Home Screen, then open the app.');
    } else {
      setStatus('Notifications are not supported in this browser.');
    }
    return;
  }

  // Already denied: NEVER re-prompt (AC 5). Show static guidance only.
  if (Notification.permission === 'denied') {
    setStatus('Notifications are blocked. Enable them for this site in your browser settings.');
    return;
  }

  btn.style.display = 'inline-block';
  setStatus('');

  // Permission is requested ONLY here, inside the click handler (AC 5).
  btn.addEventListener('click', function() {
    if (Notification.permission === 'denied') {
      setStatus('Notifications are blocked. Enable them for this site in your browser settings.');
      return;
    }
    btn.disabled = true;
    Notification.requestPermission().then(function(perm) {
      if (perm !== 'granted') {
        btn.disabled = false;
        if (perm === 'denied') {
          setStatus('Notifications are blocked. Enable them for this site in your browser settings.');
        } else {
          setStatus('');
        }
        return;
      }
      return navigator.serviceWorker.ready.then(function(reg) {
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }).then(function(subscription) {
        var json = subscription.toJSON();
        return fetch(SUBSCRIBE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoint: subscription.endpoint,
            p256dh: json.keys && json.keys.p256dh,
            auth: json.keys && json.keys.auth,
          }),
        });
      }).then(function() {
        setStatus('Notifications enabled.');
        btn.textContent = 'Notifications on';
      });
    }).catch(function() {
      btn.disabled = false;
      setStatus('');
    });
  });
})();
</script>`;
}
