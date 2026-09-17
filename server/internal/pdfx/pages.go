package pdfx

import (
	"context"
	"errors"
	"github.com/klippa-app/go-pdfium/requests"
)

var ErrPageSelection = errors.New("pdfx: invalid page selection")

// SelectPages copies original PDF pages, retaining vector drawings, images,
// fonts and text. It does not rasterize or reinterpret the document.
func SelectPages(ctx context.Context, data []byte, pages []int) ([]byte, error) {
	return Default.SelectPages(ctx, data, pages)
}

func (e *Extractor) SelectPages(ctx context.Context, data []byte, pages []int) ([]byte, error) {
	if len(data) == 0 {
		return nil, ErrEmpty
	}
	if len(data) > MaxBytes {
		return nil, ErrTooLarge
	}
	if len(pages) == 0 || len(pages) > 12 {
		return nil, ErrPageSelection
	}
	for i, page := range pages {
		if page < 1 || (i > 0 && page <= pages[i-1]) {
			return nil, ErrPageSelection
		}
	}
	pool, err := e.getPool()
	if err != nil {
		return nil, err
	}
	instance, err := pool.GetInstanceWithContext(ctx)
	if err != nil {
		return nil, err
	}
	defer instance.Close()
	source, err := instance.OpenDocument(&requests.OpenDocument{File: &data})
	if err != nil {
		return nil, err
	}
	defer instance.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: source.Document})
	count, err := instance.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: source.Document})
	if err != nil {
		return nil, err
	}
	if pages[len(pages)-1] > count.PageCount {
		return nil, ErrPageSelection
	}
	indices := make([]int, len(pages))
	for i, page := range pages {
		indices[i] = page - 1
	}
	dest, err := instance.FPDF_CreateNewDocument(&requests.FPDF_CreateNewDocument{})
	if err != nil {
		return nil, err
	}
	defer instance.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: dest.Document})
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	_, err = instance.FPDF_ImportPagesByIndex(&requests.FPDF_ImportPagesByIndex{Source: source.Document, Destination: dest.Document, PageIndices: indices})
	if err != nil {
		return nil, err
	}
	saved, err := instance.FPDF_SaveAsCopy(&requests.FPDF_SaveAsCopy{Document: dest.Document, Flags: requests.SaveFlagNoIncremental})
	if err != nil {
		return nil, err
	}
	if saved.FileBytes == nil {
		return nil, errors.New("pdfx: missing copied PDF")
	}
	return *saved.FileBytes, nil
}
