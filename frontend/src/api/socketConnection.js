/** Browser transport lifecycle kept separate from React so reconnect/unmount
 * races can be tested without adding a frontend test framework. */
export function connectAccountSocket({ userId, location, WebSocket, getToken, refreshToken, onMessage, onConnection, onExpired }) {
  let disposed = false;
  let socket = null;
  let timer = null;
  let retries = 0;
  const connect = () => {
    if (disposed || !userId) return;
    const token = getToken();
    if (!token) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Protocol credentials avoid leaking JWTs through access-log URLs. The
    // server echoes only "chorequest", never the bearer credential.
    const current = new WebSocket(`${protocol}//${location.host}/ws/${userId}`, ['chorequest', `bearer.${token}`]);
    socket = current;
    current.onopen = () => {
      if (disposed || socket !== current) return;
      retries = 0;
      onConnection(true);
      // WebSockets are not durable. Reconcile views/notification counts after
      // reconnect instead of pretending missed ephemeral events can replay.
      onMessage({ type: 'data_changed', data: { entity: 'connection' } });
    };
    current.onmessage = event => {
      if (disposed || socket !== current) return;
      try { onMessage(JSON.parse(event.data)); } catch { /* ignore malformed events */ }
    };
    current.onclose = () => {
      if (disposed || socket !== current) return;
      socket = null;
      onConnection(false);
      timer = setTimeout(async () => {
        timer = null;
        try { await refreshToken(); }
        catch { if (!disposed && !getToken()) onExpired(); }
        if (!disposed) connect();
      }, Math.min(1000 * 2 ** retries++, 30000));
    };
    current.onerror = () => current.close();
  };
  connect();
  return () => {
    disposed = true;
    clearTimeout(timer);
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
      socket = null;
    }
  };
}
