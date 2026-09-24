// ASKING THE BROWSER TO OFFER "Save password?"
//
// The sign-in form is already the shape Chrome's heuristics want — a real
// <form onSubmit>, a submit button, `name` and `autoComplete` on both fields.
// What a hash-routed SPA cannot give it is the other half of the heuristic:
// Chrome infers "that login worked" from the password form DISAPPEARING across
// a document load, and here submit is preventDefault()-ed and success only
// changes the URL fragment. No document ever loads, so the prompt never fires.
//
// `navigator.credentials.store()` is the supported way to say it outright
// instead of hoping a heuristic notices. It is Chromium-only and absent from
// TypeScript's DOM lib, so it is declared and feature-detected here; a browser
// without it still gets the form-shape heuristics, which is the best available
// answer there anyway.
//
// The browser stays the decision-maker: it suppresses the prompt on its own if
// the user has already chosen "Never for this site", and it keys saved entries
// by full origin INCLUDING PORT — so a password saved against :5173 will not be
// offered on :5174.

declare global {
  interface Window {
    PasswordCredential?: new (data: { id: string; password: string; name?: string }) => Credential
  }
}

export function offerToSavePassword(id: string, password: string, name?: string) {
  try {
    const PasswordCredentialCtor = window.PasswordCredential
    if (!PasswordCredentialCtor || !navigator.credentials?.store) return
    // Fire and forget. Nothing about signing in should wait on, or be able to
    // be broken by, a convenience prompt.
    void navigator.credentials.store(new PasswordCredentialCtor({ id, password, name })).catch(() => {})
  } catch {
    /* ignore */
  }
}
