package auth

import "context"

// NeedsOnboarding is explicit rather than inferred from optional school fields.
// Accounts created before the onboarding rollout keep their existing access.
func (a *Auth) NeedsOnboarding(ctx context.Context, userID string) (bool, error) {
	var pending bool
	err := a.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM "AccountOnboarding" WHERE "userId"=$1 AND "completedAt" IS NULL)`, userID).Scan(&pending)
	return pending, err
}
