import { SignInResult, TgClient, TgDialog, TgIncomingMessage } from '../client/telegram-client.port';

/** Test double for the GramJS port. */
export class FakeTgClient implements TgClient {
  connected = false;
  handler: ((m: TgIncomingMessage) => void) | null = null;
  needsPassword = false;
  goodCode = '12345';
  goodPassword = 'pw';
  connectError: unknown = null;
  dialogs: TgDialog[] = [];
  calls: string[] = [];

  async connect(): Promise<void> {
    this.calls.push('connect');
    if (this.connectError) throw this.connectError;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.calls.push('disconnect');
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendCode(_phone: string): Promise<{ phoneCodeHash: string }> {
    this.calls.push('sendCode');
    return { phoneCodeHash: 'hash' };
  }

  async signIn(_p: string, _h: string, code: string): Promise<SignInResult> {
    this.calls.push('signIn');
    if (code !== this.goodCode) throw Object.assign(new Error('rpc'), { errorMessage: 'PHONE_CODE_INVALID' });
    return this.needsPassword ? 'password_needed' : 'ok';
  }

  async signInWithPassword(pw: string): Promise<void> {
    this.calls.push('password');
    if (pw !== this.goodPassword) throw Object.assign(new Error('rpc'), { errorMessage: 'PASSWORD_HASH_INVALID' });
  }

  exportSession(): string {
    return 'SESSION';
  }

  async listDialogs(): Promise<TgDialog[]> {
    return this.dialogs;
  }

  onMessage(h: (m: TgIncomingMessage) => void): void {
    this.handler = h;
  }

  async logOut(): Promise<void> {
    this.calls.push('logOut');
  }
}
