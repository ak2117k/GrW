import type { Socket } from 'socket.io';
import { requireAdminSocket } from './authenticate-admin-socket';
import { SignalGateway } from '../../modules/signal-generator/gateways/signal.gateway';
import { TelegramGateway } from '../../modules/telegram/gateways/telegram.gateway';
import { WatchGateway } from '../../modules/watch-monitor/gateways/watch.gateway';
import { UngatedWatchGateway } from '../../modules/ungated-track/gateways/ungated-watch.gateway';
import { AdaptiveStopGateway } from '../../modules/adaptive-stop-track/gateways/adaptive-stop.gateway';

/**
 * Every ADMIN-only gateway must reject a non-admin socket, but the rejection has
 * to stay scoped to ITS OWN namespace.
 *
 * socket.io multiplexes every namespace the browser opens over a SINGLE
 * engine.io transport. `socket.disconnect(true)` calls `client._disconnect()`,
 * which disconnects EVERY namespace socket on that transport and then closes it
 * — so one admin gateway rejecting a normal user also kills that user's `/ws`
 * tick feed, `/ws/trades` and `/ws/auto-trade`. `disconnect()` (close=false)
 * sends a DISCONNECT packet for this namespace only and leaves the shared
 * transport — and therefore the other namespaces — untouched.
 */
function nonAdminSocket(): Socket & { disconnect: jest.Mock } {
  return {
    id: 'sock-1',
    handshake: { auth: {}, headers: {} },
    disconnect: jest.fn(),
  } as unknown as Socket & { disconnect: jest.Mock };
}

const GATEWAYS: [string, { handleConnection(client: Socket): void }][] = [
  ['SignalGateway', new SignalGateway()],
  ['TelegramGateway', new TelegramGateway()],
  ['WatchGateway', new WatchGateway()],
  ['UngatedWatchGateway', new UngatedWatchGateway()],
  ['AdaptiveStopGateway', new AdaptiveStopGateway()],
];

describe.each(GATEWAYS)('%s admin rejection', (_name, gateway) => {
  it('disconnects a non-admin socket', () => {
    const client = nonAdminSocket();
    gateway.handleConnection(client);
    expect(client.disconnect).toHaveBeenCalled();
  });

  it('does NOT close the shared transport (no disconnect(true))', () => {
    const client = nonAdminSocket();
    gateway.handleConnection(client);
    // close=true would tear down every other namespace on the same transport.
    expect(client.disconnect).not.toHaveBeenCalledWith(true);
  });
});

describe('requireAdminSocket', () => {
  it('rejects a non-admin socket without closing the shared transport', () => {
    const client = nonAdminSocket();
    expect(requireAdminSocket(client)).toBe(false);
    expect(client.disconnect).toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalledWith(true);
  });
});
