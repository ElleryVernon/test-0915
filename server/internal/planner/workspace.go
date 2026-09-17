package planner

import (
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

// BatchBlock is an additive proposal. No existing event may be edited by a batch.
type BatchBlock struct {
	Title     string  `json:"title"`
	Date      string  `json:"date"`
	Start     string  `json:"start"`
	End       string  `json:"end"`
	Kind      string  `json:"kind"`
	SubjectID *string `json:"subjectId"`
}

func ValidateBatch(blocks []BatchBlock) error {
	if len(blocks) == 0 || len(blocks) > 200 {
		return errors.New("한 번에 1~200개의 일정을 담을 수 있어요")
	}
	earliest, latest := "9999-99-99", ""
	for i, b := range blocks {
		day, e := time.Parse("2006-01-02", b.Date)
		start, se := time.Parse("15:04", b.Start)
		end, ee := time.Parse("15:04", b.End)
		if e != nil || day.Format("2006-01-02") != b.Date || se != nil || ee != nil || start.Format("15:04") != b.Start || end.Format("15:04") != b.End || !start.Before(end) || strings.TrimSpace(b.Title) == "" || utf8.RuneCountInString(b.Title) > 100 || (b.Kind != "FIXED" && b.Kind != "FLEXIBLE") {
			return errors.New("일정의 이름, 날짜와 시간을 확인해 주세요")
		}
		if b.Date < earliest {
			earliest = b.Date
		}
		if b.Date > latest {
			latest = b.Date
		}
		for _, other := range blocks[:i] {
			if Conflict(Dated{Date: b.Date, Start: b.Start, End: b.End}, Dated{Date: other.Date, Start: other.Start, End: other.End}) {
				return errors.New("추가할 일정끼리 시간이 겹쳐요. 미리보기를 다시 확인해 주세요")
			}
		}
	}
	from, _ := time.Parse("2006-01-02", earliest)
	until, _ := time.Parse("2006-01-02", latest)
	if until.Sub(from) > 182*24*time.Hour {
		return errors.New("한 번에 등록할 기간은 최대 6개월(183일)이에요")
	}
	return nil
}

func SameBatchBlock(a, b BatchBlock) bool {
	subject := func(s *string) string {
		if s == nil {
			return ""
		}
		return *s
	}
	return strings.TrimSpace(a.Title) == strings.TrimSpace(b.Title) && a.Date == b.Date && a.Start == b.Start && a.End == b.End && a.Kind == b.Kind && subject(a.SubjectID) == subject(b.SubjectID)
}
