package api

import (
	"memoryz/server/internal/apierr"
	"strconv"
	"strings"
)

var errPDFPages = apierr.New(400, "근거 페이지를 확인하지 못했어요. PDF의 페이지를 다시 선택해 주세요.")

func requestedPDFPages(raw, mime string) ([]int, error) {
	if mime != "application/pdf" || raw == "" {
		return nil, errPDFPages
	}
	parts := strings.Split(raw, ",")
	if len(parts) > 12 {
		return nil, errPDFPages
	}
	pages := make([]int, len(parts))
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 1 || n > 10000 || strconv.Itoa(n) != part || (i > 0 && n <= pages[i-1]) {
			return nil, errPDFPages
		}
		pages[i] = n
	}
	return pages, nil
}
