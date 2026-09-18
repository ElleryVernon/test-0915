package demo

// SampleQuestion is one multiple-choice item of the sample material.
type SampleQuestion struct {
	Prompt      string
	Options     []string
	Answer      int
	Explanation string
	Citation    string
	Past        string
	Future      string
}

// SampleEssay is the written-answer item of the sample material.
type SampleEssay struct {
	Prompt      string
	Keywords    []string
	Distractors []string
	ModelAnswer string
	Citation    string
}

// SampleMaterial is the material a fresh account can copy to try the app without uploading
// anything (home "샘플 자료로 체험"). It is the demo student's neuron chapter with its two
// questions and one essay, so no model call is needed to have something to study.
type SampleMaterial struct {
	Subject   string
	Title     string
	Content   string
	Questions []SampleQuestion
	Essays    []SampleEssay
}

// Sample returns the sample material; the slices are fresh copies.
func Sample() SampleMaterial {
	const materialID = "demo-neuron"
	out := SampleMaterial{}
	for _, m := range materials {
		if m.id == materialID {
			out.Title, out.Content = m.title, m.content
			for _, s := range subjects {
				if s.id == m.subjectID {
					out.Subject = s.name
				}
			}
		}
	}
	for _, q := range questions {
		if q.materialID == materialID {
			out.Questions = append(out.Questions, SampleQuestion{Prompt: q.prompt, Options: append([]string(nil), q.options...), Answer: q.answer, Explanation: q.explanation, Citation: q.citation, Past: q.past, Future: q.future})
		}
	}
	for _, e := range essays {
		if e.materialID == materialID {
			out.Essays = append(out.Essays, SampleEssay{Prompt: e.prompt, Keywords: append([]string(nil), e.keywords...), Distractors: append([]string(nil), e.distractors...), ModelAnswer: e.modelAnswer, Citation: e.citation})
		}
	}
	return out
}

// Items returns every sample material with its questions and essays; the slices are fresh copies.
// Offline evaluations read the seeded items from here instead of a database.
func Items() []SampleMaterial {
	out := make([]SampleMaterial, 0, len(materials))
	for _, m := range materials {
		item := SampleMaterial{Title: m.title, Content: m.content}
		for _, s := range subjects {
			if s.id == m.subjectID {
				item.Subject = s.name
			}
		}
		for _, q := range questions {
			if q.materialID == m.id {
				item.Questions = append(item.Questions, SampleQuestion{Prompt: q.prompt, Options: append([]string(nil), q.options...), Answer: q.answer, Explanation: q.explanation, Citation: q.citation, Past: q.past, Future: q.future})
			}
		}
		for _, e := range essays {
			if e.materialID == m.id {
				item.Essays = append(item.Essays, SampleEssay{Prompt: e.prompt, Keywords: append([]string(nil), e.keywords...), Distractors: append([]string(nil), e.distractors...), ModelAnswer: e.modelAnswer, Citation: e.citation})
			}
		}
		out = append(out, item)
	}
	return out
}
