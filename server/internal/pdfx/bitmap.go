package pdfx

import (
	"bytes"
	"image"

	"github.com/gen2brain/webp"
	"github.com/klippa-app/go-pdfium/enums"
	xdraw "golang.org/x/image/draw"
)

// rgbaImage is the straight-alpha pixel buffer images travel in before encoding.
type rgbaImage = image.NRGBA

// webpMethod is libwebp's speed/quality trade-off (0 fastest, 6 best); 4 is libwebp's default and
// what the canvas encoder the TypeScript used runs with.
const webpMethod = 4

// rgbaFromBitmap converts a pdfium bitmap buffer (a view into WebAssembly memory, valid only until
// the bitmap is destroyed) into an owned RGBA image.
func rgbaFromBitmap(buf []byte, width, height, stride int, format enums.FPDF_BITMAP_FORMAT) *rgbaImage {
	if width <= 0 || height <= 0 || stride <= 0 || len(buf) < stride*height {
		return nil
	}
	var bytesPerPixel int
	switch format {
	case enums.FPDF_BITMAP_FORMAT_BGRA, enums.FPDF_BITMAP_FORMAT_BGRX:
		bytesPerPixel = 4
	case enums.FPDF_BITMAP_FORMAT_BGR:
		bytesPerPixel = 3
	case enums.FPDF_BITMAP_FORMAT_GRAY:
		bytesPerPixel = 1
	default:
		return nil
	}
	if stride < width*bytesPerPixel {
		return nil
	}
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		row := buf[y*stride : y*stride+width*bytesPerPixel]
		out := img.Pix[y*img.Stride : y*img.Stride+width*4]
		switch format {
		case enums.FPDF_BITMAP_FORMAT_BGRA:
			for x := 0; x < width; x++ {
				out[x*4], out[x*4+1], out[x*4+2], out[x*4+3] = row[x*4+2], row[x*4+1], row[x*4], row[x*4+3]
			}
		case enums.FPDF_BITMAP_FORMAT_BGRX:
			for x := 0; x < width; x++ {
				out[x*4], out[x*4+1], out[x*4+2], out[x*4+3] = row[x*4+2], row[x*4+1], row[x*4], 255
			}
		case enums.FPDF_BITMAP_FORMAT_BGR:
			for x := 0; x < width; x++ {
				out[x*4], out[x*4+1], out[x*4+2], out[x*4+3] = row[x*3+2], row[x*3+1], row[x*3], 255
			}
		case enums.FPDF_BITMAP_FORMAT_GRAY:
			for x := 0; x < width; x++ {
				out[x*4], out[x*4+1], out[x*4+2], out[x*4+3] = row[x], row[x], row[x], 255
			}
		}
	}
	return img
}

// downscale shrinks an image so its longest side is at most edge, as the TypeScript canvas did
// (Math.round of the scaled sides).
func downscale(img *rgbaImage, edge int) *rgbaImage {
	width, height := img.Rect.Dx(), img.Rect.Dy()
	longest := max(width, height)
	if longest <= edge {
		return img
	}
	scale := float64(edge) / float64(longest)
	target := image.NewNRGBA(image.Rect(0, 0, max(1, int(float64(width)*scale+0.5)), max(1, int(float64(height)*scale+0.5))))
	xdraw.BiLinear.Scale(target, target.Rect, img, img.Rect, xdraw.Src, nil)
	return target
}

// encodeWebP encodes with the quality the TypeScript extractor used; nil when encoding fails.
func encodeWebP(img *rgbaImage) []byte {
	var buf bytes.Buffer
	if err := webp.Encode(&buf, img, webp.Options{Quality: webpQuality, Method: webpMethod}); err != nil {
		return nil
	}
	return buf.Bytes()
}
