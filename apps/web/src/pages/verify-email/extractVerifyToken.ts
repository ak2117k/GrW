export function extractVerifyToken(search: string): string | null {
  const t = new URLSearchParams(search).get('token')?.trim();
  return t ? t : null;
}
