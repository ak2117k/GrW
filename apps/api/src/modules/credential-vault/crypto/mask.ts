/**
 * Mask a client-id for non-secret display / audit metadata (TDA-005 §4.1).
 * e.g. "AB1234" -> "A•••34". Short ids collapse gracefully; never reveals the
 * full value.
 */
export function maskClientId(clientId: string): string {
  if (!clientId) return '••';
  if (clientId.length <= 2) return `${clientId[0] ?? ''}••`;
  return `${clientId[0]}•••${clientId.slice(-2)}`;
}
