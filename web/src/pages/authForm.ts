/** Client-side checks shared by the sign-in forms (the server validates again). */

export const MIN_PASSWORD = 8

export function emailError(email: string): string | null {
  const v = email.trim()
  if (!v) return 'Enter your email address.'
  if (!/^[^\s@]+@[^\s@]+$/.test(v)) return 'Enter a valid email address, like name@example.com.'
  return null
}

export function newPasswordError(password: string): string | null {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`
  return null
}

export function nameError(name: string): string | null {
  const v = name.trim()
  if (!v) return 'Enter your name.'
  if (v.length > 100) return 'Names can be at most 100 characters.'
  return null
}
