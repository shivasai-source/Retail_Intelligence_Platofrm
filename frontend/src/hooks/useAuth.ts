import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, apiFetch, apiPost } from '../lib/api'
import { offerToSavePassword } from '../lib/credentials'
import type { LoginResult, PortalUser } from '../types/portal'

// The current session's user, from the httpOnly cookie FastAPI set on
// login — not from localStorage. A 401 resolves to an error immediately
// (no retries) so "signed out" is instant; RequireAuth and Login both key
// off that to mean "signed out."
export function useCurrentUser() {
  return useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiFetch<PortalUser>('/auth/me'),
    // Only a 401 actually means "signed out", and it is final. Anything else
    // — the backend restarting mid-navigation, a dropped connection — is
    // transient and gets a retry instead of being read as a lost session.
    retry: (failureCount, error) => !(error instanceof ApiError && error.status === 401) && failureCount < 2,
    // The session lives in an httpOnly cookie with a 14-day TTL, so it cannot
    // go stale between two route changes. Without this the query inherited the
    // client's 30s staleTime and refetched on EVERY page mount; one hiccup on
    // that refetch bounced the user back to /login mid-session.
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: false,
  })
}

// Replaces the old client-only usePortalUserStore.signIn — the backend now
// actually validates the password (after the first login for an email,
// which creates the account). Writes straight into the ['auth','me'] cache
// on success so useCurrentUser() elsewhere doesn't need a second round-trip.
export function useLogin() {
  const queryClient = useQueryClient()
  return useMutation({
    // The save prompt is asked for HERE rather than from the Login page's own
    // onSuccess, for two reasons. It runs on exactly the condition wanted — a
    // 2xx from /auth/login, never a failure — without depending on React
    // Query's callback lifecycle, which is tied to the calling component still
    // being mounted; and login succeeding is a property of this mutation, not
    // of whichever screen happened to trigger it. `credentials.ts` explains
    // what the call is for.
    mutationFn: async (body: { email: string; password: string }) => {
      const result = await apiPost<LoginResult>('/auth/login', body)
      offerToSavePassword(body.email, body.password, result.user.name)
      return result
    },
    onSuccess: (result) => {
      queryClient.setQueryData(['auth', 'me'], result.user)
    },
  })
}

export function useLogout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiPost<{ ok: boolean }>('/auth/logout', {}),
    onSuccess: () => {
      queryClient.setQueryData(['auth', 'me'], undefined)
      queryClient.removeQueries({ queryKey: ['auth', 'me'] })
    },
  })
}
