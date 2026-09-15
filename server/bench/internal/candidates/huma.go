package candidates

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"

	"memoryz/bench/internal/app"
)

// body is the huma output wrapper: the Body field becomes the JSON response.
type body[T any] struct{ Body T }

// newHuma registers typed huma operations on a net/http ServeMux through the
// humago adapter. DefaultConfig's CreateHooks are cleared so the `$schema`
// link transformer does not add a field to every response body; everything
// else (encoding/json format, request validation, docs routes) is default.
func newHuma(store *app.Store) http.Handler {
	mux := http.NewServeMux()
	cfg := huma.DefaultConfig("memoryz bench", "1.0.0")
	cfg.CreateHooks = nil
	api := humago.New(mux, cfg)

	huma.Get(api, "/json", func(ctx context.Context, _ *struct{}) (*body[app.Hello], error) {
		return &body[app.Hello]{Body: app.NewHello()}, nil
	})
	huma.Get(api, "/users/{id}", func(ctx context.Context, in *struct {
		ID string `path:"id"`
	}) (*body[app.User], error) {
		return &body[app.User]{Body: app.NewUser(in.ID)}, nil
	})
	huma.Post(api, "/echo", func(ctx context.Context, in *struct {
		Body app.EchoBody
	}) (*body[app.EchoBody], error) {
		return &body[app.EchoBody]{Body: in.Body}, nil
	})
	huma.Get(api, "/db", func(ctx context.Context, in *struct {
		ID string `query:"id"`
	}) (*body[app.Row], error) {
		row, err := store.LookupByQuery(ctx, in.ID)
		if err != nil {
			return nil, huma.NewError(app.StatusFor(err), err.Error())
		}
		return &body[app.Row]{Body: row}, nil
	})
	return mux
}
