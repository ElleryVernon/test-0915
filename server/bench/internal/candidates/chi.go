package candidates

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"memoryz/bench/internal/app"
)

// newChi routes with chi; handlers are plain net/http handlers.
func newChi(store *app.Store) http.Handler {
	r := chi.NewRouter()
	r.Get("/json", func(w http.ResponseWriter, r *http.Request) {
		app.WriteJSON(w, http.StatusOK, app.NewHello())
	})
	r.Get("/users/{id}", func(w http.ResponseWriter, r *http.Request) {
		app.WriteJSON(w, http.StatusOK, app.NewUser(chi.URLParam(r, "id")))
	})
	r.Post("/echo", func(w http.ResponseWriter, r *http.Request) {
		var body app.EchoBody
		if err := app.ReadJSON(r.Body, &body); err != nil {
			app.WriteJSON(w, http.StatusBadRequest, app.ErrorBody{Error: err.Error()})
			return
		}
		app.WriteJSON(w, http.StatusOK, body)
	})
	r.Get("/db", func(w http.ResponseWriter, r *http.Request) {
		row, err := store.LookupByQuery(r.Context(), r.URL.Query().Get("id"))
		if err != nil {
			app.WriteError(w, err)
			return
		}
		app.WriteJSON(w, http.StatusOK, row)
	})
	return r
}
