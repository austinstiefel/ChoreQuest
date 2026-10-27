import { useEffect, useRef, useState } from 'react';
import { getAccessToken, ensureToken } from '../api/client';
import { connectAccountSocket } from '../api/socketConnection';

export function useWebSocket(userId, onMessage) {
  const callback = useRef(onMessage);
  callback.current = onMessage;
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    setConnected(false);
    return connectAccountSocket({
      userId, location: window.location, WebSocket: window.WebSocket,
      getToken: getAccessToken, refreshToken: ensureToken,
      onMessage: message => callback.current?.(message),
      onConnection: setConnected,
      onExpired: () => window.dispatchEvent(new CustomEvent('auth:expired')),
    });
  }, [userId]);
  return { connected };
}
