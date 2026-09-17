package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
	"memoryz/server/internal/apierr"
	"memoryz/server/internal/demo"
	"memoryz/server/internal/httpx"
	"memoryz/server/internal/ids"
	"memoryz/server/internal/store"
)

func init() {
	register(func(s *Server, mux *http.ServeMux) {
		mux.Handle("/api/points", httpx.Methods{http.MethodGet: s.withUser(s.pointWallet, store.RolePARENT)})
		mux.Handle("/api/points/orders", httpx.Methods{http.MethodPost: s.withUser(s.createTopup, store.RolePARENT)})
		mux.Handle("/api/points/confirm", httpx.Methods{http.MethodPost: s.withUser(s.confirmTopup, store.RolePARENT)})
		mux.Handle("/api/points/orders/{id}/check", httpx.Methods{http.MethodPost: s.withUser(s.checkTopup, store.RolePARENT)})
	})
}

type topup struct {
	ID        string    `json:"id"`
	Amount    int       `json:"amount"`
	Mode      string    `json:"mode"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
	key       *string
}

const topupColumns = `"id","amount","mode","status","createdAt","paymentKey"`

func scanTopup(row pgx.Row) (o topup, err error) {
	err = row.Scan(&o.ID, &o.Amount, &o.Mode, &o.Status, &o.CreatedAt, &o.key)
	return
}
func (s *Server) ownedTopup(ctx context.Context, id, userID string) (topup, error) {
	o, err := scanTopup(s.pool.QueryRow(ctx, `SELECT `+topupColumns+` FROM "PointTopup" WHERE "id"=$1 AND "userId"=$2`, id, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return o, apierr.ErrMissing
	}
	return o, err
}

var topupRequestID = regexp.MustCompile(`^[a-zA-Z0-9_-]{16,80}$`)
var errPaymentUnavailable = apierr.WithCode(503, "포인트 충전을 준비하고 있어요. 결제 연결이 완료되면 이용할 수 있어요.", "PAYMENT_UNAVAILABLE")
var errPaymentPending = apierr.WithCode(503, "결제 결과를 아직 확인하지 못했어요. 다시 결제하지 말고 이 주문의 상태를 확인해 주세요.", "PAYMENT_PENDING")

func (s *Server) paymentModeFor(user store.User) string {
	mode := s.cfg.PaymentMode()
	if mode == "live" && (user.ID == demo.Parent || user.ID == demo.Student || user.ID == demo.Admin) {
		return "unavailable"
	}
	return mode
}

func (s *Server) pointWallet(w http.ResponseWriter, r *http.Request, user store.User) error {
	rows, err := s.pool.Query(r.Context(), `SELECT `+topupColumns+` FROM "PointTopup" WHERE "userId"=$1 ORDER BY "createdAt" DESC LIMIT 30`, user.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	orders := []topup{}
	for rows.Next() {
		o, e := scanTopup(rows)
		if e != nil {
			return e
		}
		orders = append(orders, o)
	}
	if rows.Err() != nil {
		return rows.Err()
	}
	var balance int
	if err = s.pool.QueryRow(r.Context(), `SELECT "points" FROM "User" WHERE "id"=$1`, user.ID).Scan(&balance); err != nil {
		return err
	}
	httpx.OK(w, 200, map[string]any{"balance": balance, "mode": s.paymentModeFor(user), "wonPerPoint": 1, "minAmount": 1000, "maxAmount": 100000, "orders": orders})
	return nil
}
func (s *Server) createTopup(w http.ResponseWriter, r *http.Request, user store.User) error {
	mode := s.paymentModeFor(user)
	if mode == "unavailable" {
		return errPaymentUnavailable
	}
	var in struct {
		Amount    int    `json:"amount"`
		RequestID string `json:"requestId"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	if in.Amount < 1000 || in.Amount > 100000 || !topupRequestID.MatchString(in.RequestID) {
		return apierr.New(400, "충전 금액은 1,000원부터 100,000원까지 입력해 주세요.")
	}
	// Bound abandoned requests per user without invalidating an idempotent retry.
	var pending int
	if err := s.pool.QueryRow(r.Context(), `SELECT count(*) FROM "PointTopup" WHERE "userId"=$1 AND "createdAt">now()-interval '1 hour' AND "requestId"<>$2`, user.ID, in.RequestID).Scan(&pending); err != nil {
		return err
	}
	if pending >= 20 {
		return apierr.New(429, "충전을 여러 번 요청했어요. 잠시 후 다시 시도해 주세요.")
	}
	var o topup
	err := s.locked(r.Context(), user.ID, func(tx pgx.Tx, _ *store.Queries) error {
		var unresolved bool
		if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM "PointTopup" WHERE "userId"=$1 AND "status"='VERIFYING' AND "requestId"<>$2)`, user.ID, in.RequestID).Scan(&unresolved); err != nil {
			return err
		}
		if unresolved {
			return apierr.WithCode(409, "확인 중인 충전이 있어요. 최근 충전 내역에서 결과를 먼저 확인해 주세요.", "PAYMENT_PENDING")
		}
		var err error
		o, err = scanTopup(tx.QueryRow(r.Context(), `INSERT INTO "PointTopup" ("id","userId","requestId","amount","mode") VALUES ($1,$2,$3,$4,$5) ON CONFLICT ("userId","requestId") DO UPDATE SET "requestId"=EXCLUDED."requestId" RETURNING `+topupColumns, "mz_"+ids.New(), user.ID, in.RequestID, in.Amount, mode))
		return err
	})
	if err != nil {
		return err
	}

	if o.Amount != in.Amount || o.Mode != mode {
		return apierr.New(409, "이미 만든 주문의 금액은 바꿀 수 없어요.")
	}
	httpx.OK(w, 200, map[string]any{"order": o, "clientKey": s.cfg.TossClientKey, "customerKey": "memoryz_" + user.ID})
	return nil
}

type tossPayment struct {
	PaymentKey  string `json:"paymentKey"`
	OrderID     string `json:"orderId"`
	Status      string `json:"status"`
	TotalAmount int    `json:"totalAmount"`
	Currency    string `json:"currency"`
}

func (s *Server) toss(ctx context.Context, method, path string, body any, id string) (tossPayment, error) {
	var p tossPayment
	var data io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return p, err
		}
		data = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, "https://api.tosspayments.com"+path, data)
	if err != nil {
		return p, err
	}
	req.SetBasicAuth(s.cfg.TossSecretKey, "")
	req.Header.Set("Content-Type", "application/json")
	if id != "" {
		req.Header.Set("Idempotency-Key", id)
	}
	client := s.paymentHTTP
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	res, err := client.Do(req)
	if err != nil {
		return p, errPaymentPending
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return p, errPaymentPending
	}
	if json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&p) != nil {
		return p, errPaymentPending
	}
	return p, nil
}
func (s *Server) confirmTopup(w http.ResponseWriter, r *http.Request, user store.User) error {
	if s.paymentModeFor(user) == "unavailable" {
		return errPaymentUnavailable
	}
	var in struct {
		OrderID    string `json:"orderId"`
		PaymentKey string `json:"paymentKey"`
		Amount     int    `json:"amount"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		return err
	}
	o, err := s.ownedTopup(r.Context(), in.OrderID, user.ID)
	if err != nil {
		return err
	}
	if o.Amount != in.Amount || len(in.PaymentKey) < 8 || len(in.PaymentKey) > 200 || o.Mode != s.cfg.PaymentMode() {
		return apierr.New(400, "주문 정보가 일치하지 않아 결제를 진행하지 않았어요.")
	}
	if o.key != nil && *o.key != in.PaymentKey {
		return apierr.New(409, "이 주문에 등록된 결제 정보가 달라요.")
	}
	if o.Status == "DONE" {
		httpx.OK(w, 200, o)
		return nil
	}
	if o.Status == "FAILED" {
		return apierr.New(409, "취소되거나 만료된 결제예요. 충전 화면에서 새로 시작해 주세요.")
	}
	// Persist the provider key BEFORE any approval so a disconnected browser can recover by order ID.
	tag, err := s.pool.Exec(r.Context(), `UPDATE "PointTopup" SET "paymentKey"=$3,"status"='VERIFYING' WHERE "id"=$1 AND "userId"=$2 AND ("paymentKey" IS NULL OR "paymentKey"=$3) AND "status" IN ('READY','VERIFYING')`, o.ID, user.ID, in.PaymentKey)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return apierr.New(409, "결제 정보가 변경됐어요. 주문 상태를 확인해 주세요.")
	}
	o.key = &in.PaymentKey
	p, err := s.toss(r.Context(), http.MethodPost, "/v1/payments/confirm", in, o.ID)
	if err != nil {
		p, err = s.toss(r.Context(), http.MethodGet, "/v1/payments/orders/"+url.PathEscape(o.ID), nil, "")
	}
	if err != nil {
		return err
	}
	if err = s.resolveTopup(r.Context(), user.ID, o, p); err != nil {
		return err
	}
	s.auth.Invalidate(r.Context(), user.ID)
	o.Status = "DONE"
	httpx.OK(w, 200, o)
	return nil
}
func (s *Server) checkTopup(w http.ResponseWriter, r *http.Request, user store.User) error {
	o, err := s.ownedTopup(r.Context(), r.PathValue("id"), user.ID)
	if err != nil {
		return err
	}
	if o.Status == "DONE" || o.Status == "FAILED" {
		httpx.OK(w, 200, o)
		return nil
	}
	if o.Mode != s.cfg.PaymentMode() {
		return errPaymentUnavailable
	}
	if o.key == nil {
		httpx.OK(w, 200, o)
		return nil
	}
	p, err := s.toss(r.Context(), http.MethodGet, "/v1/payments/orders/"+url.PathEscape(o.ID), nil, "")
	if err != nil {
		return err
	}
	if err = s.resolveTopup(r.Context(), user.ID, o, p); err != nil {
		return err
	}
	o.Status = "DONE"
	s.auth.Invalidate(r.Context(), user.ID)
	httpx.OK(w, 200, o)
	return nil
}

// Provider terminal outcomes are resolved consistently from callback and recovery.
func (s *Server) resolveTopup(ctx context.Context, userID string, o topup, p tossPayment) error {
	if o.key == nil || p.PaymentKey != *o.key || p.OrderID != o.ID || p.TotalAmount != o.Amount || p.Currency != "KRW" {
		return errPaymentPending
	}
	if p.Status == "CANCELED" || p.Status == "ABORTED" || p.Status == "EXPIRED" {
		_, err := s.pool.Exec(ctx, `UPDATE "PointTopup" SET "status"='FAILED' WHERE "id"=$1 AND "userId"=$2 AND "status"<>'DONE'`, o.ID, userID)
		if err != nil {
			return err
		}
		return apierr.WithCode(409, "취소되거나 만료된 결제예요. 포인트가 적립되지 않았어요.", "PAYMENT_FAILED")
	}
	return s.settleTopup(ctx, userID, o, p)
}

func (s *Server) settleTopup(ctx context.Context, userID string, o topup, p tossPayment) error {
	if o.key == nil || p.PaymentKey != *o.key || p.OrderID != o.ID || p.TotalAmount != o.Amount || p.Currency != "KRW" || p.Status != "DONE" {
		return errPaymentPending
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// The state transition and balance increment share one transaction; concurrent approvals credit once.
	tag, err := tx.Exec(ctx, `UPDATE "PointTopup" SET "status"='DONE',"creditedAt"=now() WHERE "id"=$1 AND "userId"=$2 AND "status"='VERIFYING'`, o.ID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		var status string
		if err = tx.QueryRow(ctx, `SELECT "status" FROM "PointTopup" WHERE "id"=$1 AND "userId"=$2`, o.ID, userID).Scan(&status); err != nil {
			return err
		}
		if status != "DONE" {
			return errPaymentPending
		}
	}
	if tag.RowsAffected() > 0 {
		_, err = tx.Exec(ctx, `UPDATE "User" SET "points"="points"+$2 WHERE "id"=$1`, userID, o.Amount)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
