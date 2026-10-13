// Lightweight {placeholder} substitution for broadcast messages.
// Only the keys listed here are recognized; unknown {tokens} are left intact
// so admins notice typos rather than getting silent empty strings.

export type PersonalizeContext = {
  firstName?: string | null
  username?: string | null
}

const FALLBACKS = {
  firstName: 'trader',
  username: 'friend',
} as const

export function personalizeMessage(
  template: string,
  ctx: PersonalizeContext,
): string {
  const firstName = (ctx.firstName ?? '').trim() || FALLBACKS.firstName
  const username = ctx.username
    ? `@${ctx.username.replace(/^@/, '')}`
    : `@${FALLBACKS.username}`
  const name = (ctx.firstName ?? '').trim() || username

  return template
    .replaceAll('{first_name}', firstName)
    .replaceAll('{firstname}', firstName)
    .replaceAll('{username}', username)
    .replaceAll('{name}', name)
}

// Available placeholders, surfaced to admins in the compose prompt.
export const PLACEHOLDER_HINT =
  'Available placeholders: `{first_name}`, `{username}`, `{name}`'
