package learning

// MaxSourceRunes is shared by upload, material editing, generation context and the
// model task. It admits full university chapters without silently dropping text.
// The supplied corpus peaks at ~353k characters; combined sources remain bounded.
const MaxSourceRunes = 500_000
