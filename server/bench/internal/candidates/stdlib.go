package candidates

import (
	"net/http"

	"memoryz/bench/internal/app"
)

// newStdlib routes with Go 1.22+ http.ServeMux method/pattern routing.
func newStdlib(store *app.Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /json", func(w http.ResponseWriter, r *http.Request) {
		app.WriteJSON(w, http.StatusOK, app.NewHello())
	})
	mux.HandleFunc("GET /users/{id}", func(w http.ResponseWriter, r *http.Request) {
		app.WriteJSON(w, http.StatusOK, app.NewUser(r.PathValue("id")))
	})
	mux.HandleFunc("POST /echo", func(w http.ResponseWriter, r *http.Request) {
		var body app.EchoBody
		if err := app.ReadJSON(r.Body, &body); err != nil {
			app.WriteJSON(w, http.StatusBadRequest, app.ErrorBody{Error: err.Error()})
			return
		}
		app.WriteJSON(w, http.StatusOK, body)
	})
	mux.HandleFunc("GET /db", func(w http.ResponseWriter, r *http.Request) {
		row, err := store.LookupByQuery(r.Context(), r.URL.Query().Get("id"))
		if err != nil {
			app.WriteError(w, err)
			return
		}
		app.WriteJSON(w, http.StatusOK, row)
	})
	return mux
}
