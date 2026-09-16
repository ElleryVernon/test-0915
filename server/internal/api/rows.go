package api

import (
	"encoding/json"
	"strings"

	"memoryz/server/internal/jsonx"
	"memoryz/server/internal/store"
)

// The previous server answered many endpoints with whole Prisma rows. These projections keep that
// shape: every column in camelCase, timestamps as ISO strings, nulls as null.

type subjectRow struct {
	ID        string     `json:"id"`
	UserID    string     `json:"userId"`
	Name      string     `json:"name"`
	Icon      string     `json:"icon"`
	Semester  string     `json:"semester"`
	Color     string     `json:"color"`
	ExamName  *string    `json:"examName"`
	ExamDate  *string    `json:"examDate"`
	Deleted   bool       `json:"deleted"`
	CreatedAt jsonx.Time `json:"createdAt"`
}

func subjectOf(s store.Subject) subjectRow {
	return subjectRow{ID: s.ID, UserID: s.UserID, Name: s.Name, Icon: s.Icon, Semester: s.Semester, Color: s.Color, ExamName: s.ExamName, ExamDate: s.ExamDate, Deleted: s.Deleted, CreatedAt: jsonx.Time(s.CreatedAt)}
}

type materialRow struct {
	ID            string     `json:"id"`
	UserID        string     `json:"userId"`
	SubjectID     string     `json:"subjectId"`
	Title         string     `json:"title"`
	Content       string     `json:"content"`
	Type          string     `json:"type"`
	URL           *string    `json:"url"`
	UploadID      *string    `json:"uploadId"`
	PageBreaks    []int32    `json:"pageBreaks"`
	Extraction    *string    `json:"extraction"`
	ContentHash   string     `json:"contentHash"`
	Excerpt       string     `json:"excerpt"`
	ContentLength int        `json:"contentLength"`
	CreatedAt     jsonx.Time `json:"createdAt"`
}

func materialOf(m store.Material) materialRow {
	breaks := m.PageBreaks
	if breaks == nil {
		breaks = []int32{}
	}
	return materialRow{ID: m.ID, UserID: m.UserID, SubjectID: m.SubjectID, Title: m.Title, Content: m.Content, Type: m.Type, URL: m.Url, UploadID: m.UploadID, PageBreaks: breaks, Extraction: m.Extraction, ContentHash: m.ContentHash, Excerpt: m.Excerpt, ContentLength: length(strings.TrimSpace(m.Content)), CreatedAt: jsonx.Time(m.CreatedAt)}
}

type scheduleRow struct {
	ID        string     `json:"id"`
	UserID    string     `json:"userId"`
	Title     string     `json:"title"`
	Date      string     `json:"date"`
	Start     string     `json:"start"`
	End       string     `json:"end"`
	Kind      string     `json:"kind"`
	SubjectID *string    `json:"subjectId"`
	Done      bool       `json:"done"`
	CreatedAt jsonx.Time `json:"createdAt"`
}

// cardView is asCard(): the row with nextReviewAt as ISO, image omitted when null, masks and fsrs
// as JSON documents and, when known, the completed review count.
type cardView struct {
	Diagram          json.RawMessage `json:"diagram,omitempty"`
	MaskedNodeIDs    []string        `json:"maskedNodeIds,omitempty"`
	SourceDiagramID  *string         `json:"sourceDiagramId,omitempty"`
	ID               string          `json:"id"`
	UserID           string          `json:"userId"`
	SubjectID        string          `json:"subjectId"`
	Front            string          `json:"front"`
	Back             string          `json:"back"`
	Type             string          `json:"type"`
	Bucket           string          `json:"bucket"`
	ConsecutiveEasy  int32           `json:"consecutiveEasy"`
	NextReviewAt     jsonx.Time      `json:"nextReviewAt"`
	Deleted          bool            `json:"deleted"`
	Image            *string         `json:"image,omitempty"`
	Masks            json.RawMessage `json:"masks"`
	SourceQuestionID *string         `json:"sourceQuestionId"`
	MaterialID       *string         `json:"materialId"`
	Fsrs             json.RawMessage `json:"fsrs"`
	CreatedAt        jsonx.Time      `json:"createdAt"`
	ReviewCount      *int32          `json:"reviewCount,omitempty"`
}

func cardOf(c store.Card, reviewCount *int32) cardView {
	masks := json.RawMessage(c.Masks)
	if len(masks) == 0 {
		masks = json.RawMessage("[]")
	}
	fsrs := json.RawMessage(c.Fsrs)
	if len(fsrs) == 0 {
		fsrs = json.RawMessage("null")
	}
	return cardView{
		Diagram: c.Diagram, MaskedNodeIDs: c.MaskedNodeIds, SourceDiagramID: c.SourceDiagramId,
		ID: c.ID, UserID: c.UserID, SubjectID: c.SubjectID, Front: c.Front, Back: c.Back, Type: string(c.Type), Bucket: string(c.Bucket),
		ConsecutiveEasy: c.ConsecutiveEasy, NextReviewAt: jsonx.Time(c.NextReviewAt), Deleted: c.Deleted, Image: c.Image, Masks: masks,
		SourceQuestionID: c.SourceQuestionID, MaterialID: c.MaterialID, Fsrs: fsrs, CreatedAt: jsonx.Time(c.CreatedAt), ReviewCount: reviewCount,
	}
}

// cardRow is the raw row (POST /generate for cards, wrong-note conversion): like cardView but with
// the image column always present, as Prisma returned it.
type cardRow struct {
	ID               string          `json:"id"`
	UserID           string          `json:"userId"`
	SubjectID        string          `json:"subjectId"`
	Front            string          `json:"front"`
	Back             string          `json:"back"`
	Type             string          `json:"type"`
	Bucket           string          `json:"bucket"`
	ConsecutiveEasy  int32           `json:"consecutiveEasy"`
	NextReviewAt     jsonx.Time      `json:"nextReviewAt"`
	Deleted          bool            `json:"deleted"`
	Image            *string         `json:"image"`
	Masks            json.RawMessage `json:"masks"`
	SourceQuestionID *string         `json:"sourceQuestionId"`
	MaterialID       *string         `json:"materialId"`
	Fsrs             json.RawMessage `json:"fsrs"`
	CreatedAt        jsonx.Time      `json:"createdAt"`
}

func cardRowOf(c store.Card) cardRow {
	v := cardOf(c, nil)
	return cardRow{ID: v.ID, UserID: v.UserID, SubjectID: v.SubjectID, Front: v.Front, Back: v.Back, Type: v.Type, Bucket: v.Bucket, ConsecutiveEasy: v.ConsecutiveEasy, NextReviewAt: v.NextReviewAt, Deleted: v.Deleted, Image: c.Image, Masks: v.Masks, SourceQuestionID: v.SourceQuestionID, MaterialID: v.MaterialID, Fsrs: v.Fsrs, CreatedAt: v.CreatedAt}
}

type questionRow struct {
	SavedToNotes    bool     `json:"savedToNotes,omitempty"`
	CommunityPostID string   `json:"communityPostId,omitempty"`
	ID              string   `json:"id"`
	UserID          string   `json:"userId"`
	SubjectID       string   `json:"subjectId"`
	MaterialID      string   `json:"materialId"`
	Prompt          string   `json:"prompt"`
	Options         []string `json:"options"`
	Answer          int32    `json:"answer"`
	Explanation     string   `json:"explanation"`
	Citation        string   `json:"citation"`
	Past            string   `json:"past"`
	Future          string   `json:"future"`
}

func questionOf(q store.Question) questionRow {
	options := q.Options
	if options == nil {
		options = []string{}
	}
	return questionRow{ID: q.ID, UserID: q.UserID, SubjectID: q.SubjectID, MaterialID: q.MaterialID, Prompt: q.Prompt, Options: options, Answer: q.Answer, Explanation: q.Explanation, Citation: q.Citation, Past: q.Past, Future: q.Future}
}

type essayRow struct {
	ID          string   `json:"id"`
	UserID      string   `json:"userId"`
	SubjectID   string   `json:"subjectId"`
	MaterialID  string   `json:"materialId"`
	Prompt      string   `json:"prompt"`
	Keywords    []string `json:"keywords"`
	Distractors []string `json:"distractors"`
	ModelAnswer string   `json:"modelAnswer"`
	Citation    string   `json:"citation"`
}

func essayOf(e store.Essay) essayRow {
	keywords, distractors := e.Keywords, e.Distractors
	if keywords == nil {
		keywords = []string{}
	}
	if distractors == nil {
		distractors = []string{}
	}
	return essayRow{ID: e.ID, UserID: e.UserID, SubjectID: e.SubjectID, MaterialID: e.MaterialID, Prompt: e.Prompt, Keywords: keywords, Distractors: distractors, ModelAnswer: e.ModelAnswer, Citation: e.Citation}
}

type attemptView struct {
	ResponseMs       *int32     `json:"responseMs,omitempty"`
	BeatsSeen        int32      `json:"beatsSeen"`
	ExplainDepth     *string    `json:"explainDepth,omitempty"`
	MicroResult      *string    `json:"microResult,omitempty"`
	DivergenceNodeID *string    `json:"divergenceNodeId,omitempty"`
	ID               string     `json:"id"`
	UserID           string     `json:"userId"`
	QuestionID       *string    `json:"questionId,omitempty"`
	EssayID          *string    `json:"essayId,omitempty"`
	Answer           string     `json:"answer"`
	Correct          bool       `json:"correct"`
	Score            int32      `json:"score"`
	CreatedAt        jsonx.Time `json:"createdAt"`
}

// imageMeta is one extracted image as the client sees it (contracts.ts MaterialImage).
type imageMeta struct {
	ID        string `json:"id"`
	URL       string `json:"url"`
	Page      int32  `json:"page"`
	Order     int32  `json:"order"`
	Paragraph int32  `json:"paragraph"`
	Anchor    int32  `json:"anchor"`
	Box       imgBox `json:"box"`
	Width     int32  `json:"width"`
	Height    int32  `json:"height"`
	Context   string `json:"context"`
}

type imgBox struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

func imageMetaOf(uploadID string, i store.ListUploadImagesRow) imageMeta {
	return imageMeta{ID: i.ID, URL: uploadURL(uploadID) + "/images/" + i.ID, Page: i.Page, Order: i.Order, Paragraph: i.Paragraph, Anchor: i.Anchor, Box: imgBox{X: i.X, Y: i.Y, W: i.W, H: i.H}, Width: i.Width, Height: i.Height, Context: i.Context}
}

func uploadURL(uploadID string) string { return "/api/uploads/" + uploadID }
