// Keep the site-owner identity check dependency-free so UI/API policy tests
// can exercise the exact rule without loading the database or session layer.
export const ADMIN_EMAILS = ['jmckiernan86@gmail.com', 'shanewlykins@gmail.com'];

export function isAdminEmail(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase();
  return Boolean(normalized && ADMIN_EMAILS.some((adminEmail) => adminEmail.toLowerCase() === normalized));
}
