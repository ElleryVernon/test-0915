// Package apierr carries the HTTP status, the user-facing Korean message and an optional machine code
// an endpoint answers with. The messages are part of the frontend contract and are kept verbatim
// from the TypeScript server they replace.
package apierr

import (
	"errors"
	"time"
)

// Error is an expected failure the client can act on. RetryMin and RetrySpread, when set, tell the
// client when to come back: httpx.Fail answers Retry-After = RetryMin + U[0, RetrySpread), drawn per
// response, so a crowd refused together does not return together (docs/JITTER.md).
type Error struct {
	Status      int
	Message     string
	Code        string
	RetryMin    time.Duration
	RetrySpread time.Duration
}

func (e *Error) Error() string { return e.Message }

// Retry returns a copy carrying a retry hint; shared sentinels are never mutated.
func (e *Error) Retry(min, spread time.Duration) *Error {
	c := *e
	c.RetryMin, c.RetrySpread = min, spread
	return &c
}

// Is makes a hinted copy match its sentinel: errors.Is(ErrTooMany.Retry(…), ErrTooMany) holds.
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	return ok && t.Status == e.Status && t.Message == e.Message && t.Code == e.Code
}

// New returns an Error without a machine code.
func New(status int, message string) *Error { return &Error{Status: status, Message: message} }

// WithCode returns an Error the client can branch on without parsing the message.
func WithCode(status int, message, code string) *Error {
	return &Error{Status: status, Message: message, Code: code}
}

// From unwraps the *Error inside err, if any.
func From(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}

// Shared answers.
var (
	ErrRouteNotFound = New(404, "요청한 기능을 찾을 수 없어요.")
	ErrInternal      = New(500, "요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.")
	ErrBadOrigin     = New(403, "허용되지 않은 요청 출처예요.")
	ErrTooLarge      = New(413, "입력 내용이 너무 커요.")
	ErrBadJSON       = New(400, "요청 내용을 읽을 수 없어요.")
	ErrDuplicate     = New(409, "이미 사용 중인 값이에요.")
	ErrMissing       = New(404, "대상을 찾을 수 없어요.")
	// A deadline hit is transient: automatic retries (bootstrap, review sync, AI polling) use the
	// 2–6 s hint as their floor.
	// jitter: retry-after a deadline 504 answers Retry-After 2 s + U[0,4 s), drawn per response by httpx.Fail
	ErrTimeout        = New(504, "요청이 너무 오래 걸려 중단됐어요. 잠시 후 다시 시도해 주세요.").Retry(2*time.Second, 4*time.Second)
	ErrLoginRequired  = New(401, "로그인이 필요해요.")
	ErrSessionExpired = New(401, "세션이 만료됐어요. 다시 로그인해 주세요.")
	ErrSuspended      = New(403, "이용이 제한된 계정이에요.")
	ErrRole           = New(403, "이 계정으로 접근할 수 없는 기능이에요.")
	ErrDatabase       = New(503, "데이터베이스에 연결하지 못했어요.")
	// ErrClientGone answers a request whose client disconnected (499, as proxies log it): it never
	// reaches anyone, and keeping it out of the 5xx count keeps a Wi-Fi drop from paging the operator.
	ErrClientGone = New(499, "요청이 취소됐어요.")
)
