package cache

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"sync"
	"time"
)

type entry struct {
	value   []byte
	expires time.Time // zero means never
	owner   string    // lock token
}

// Memory is a process-local cache with TTLs. It is exactly enough for one instance; the cloud
// service uses Valkey so every instance sees the same versions and counters.
type Memory struct {
	mu      sync.Mutex
	items   map[string]entry
	stop    chan struct{}
	stopped sync.Once
	now     func() time.Time
}

// NewMemory returns a cache that sweeps expired entries every minute.
func NewMemory() *Memory {
	m := &Memory{items: map[string]entry{}, stop: make(chan struct{}), now: time.Now}
	go m.sweep()
	return m
}

func (m *Memory) Name() string { return "memory" }

func (m *Memory) Flush(context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.items = map[string]entry{}
	return nil
}

func (m *Memory) sweep() {
	// jitter: none — a process-local 1-minute sweep of this process's own map; it shares nothing [site server/internal/cache/memory.go:44]
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-m.stop:
			return
		case <-ticker.C:
			m.mu.Lock()
			now := m.now()
			for k, e := range m.items {
				if !e.expires.IsZero() && !now.Before(e.expires) {
					delete(m.items, k)
				}
			}
			m.mu.Unlock()
		}
	}
}

func (m *Memory) live(key string) (entry, bool) {
	e, ok := m.items[key]
	if !ok {
		return entry{}, false
	}
	if !e.expires.IsZero() && !m.now().Before(e.expires) {
		delete(m.items, key)
		return entry{}, false
	}
	return e, true
}

func (m *Memory) Get(_ context.Context, key string) ([]byte, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.live(key)
	if !ok {
		return nil, false, nil
	}
	out := make([]byte, len(e.value))
	copy(out, e.value)
	return out, true, nil
}

func (m *Memory) Set(_ context.Context, key string, value []byte, ttl time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	stored := make([]byte, len(value))
	copy(stored, value)
	e := entry{value: stored}
	if ttl > 0 {
		e.expires = m.now().Add(ttl)
	}
	m.items[key] = e
	return nil
}

func (m *Memory) Del(_ context.Context, keys ...string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, k := range keys {
		delete(m.items, k)
	}
	return nil
}

func (m *Memory) Incr(_ context.Context, key string, ttl time.Duration) (int64, time.Duration, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.live(key)
	var n int64
	if ok {
		n = decodeInt(e.value)
	}
	now := m.now()
	// jitter: none — a fixed window whose end the refusal reports (left), spread by ratelimit's Retry-After [site server/internal/cache/memory.go:109]
	if e.expires.IsZero() && ttl > 0 {
		e.expires = now.Add(ttl)
	}
	n++
	e.value = encodeInt(n)
	m.items[key] = e
	left := time.Duration(0)
	if !e.expires.IsZero() {
		left = e.expires.Sub(now)
	}
	return n, left, nil
}

func (m *Memory) Bump(_ context.Context, key string, floor int64, ttl time.Duration) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var cur int64
	if e, ok := m.live(key); ok {
		cur, _ = strconv.ParseInt(string(e.value), 10, 64)
	}
	next := max(cur+1, floor)
	value := strconv.FormatInt(next, 10)
	e := entry{value: []byte(value)}
	if ttl > 0 {
		e.expires = m.now().Add(ttl)
	}
	m.items[key] = e
	return value, nil
}

func (m *Memory) Lock(_ context.Context, key string, ttl time.Duration) (func(), bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, held := m.live(key); held {
		return nil, false, nil
	}
	var b [8]byte
	_, _ = rand.Read(b[:])
	token := hex.EncodeToString(b[:])
	m.items[key] = entry{value: []byte(token), expires: m.now().Add(ttl), owner: token}
	var once sync.Once
	release := func() {
		once.Do(func() {
			m.mu.Lock()
			defer m.mu.Unlock()
			if e, ok := m.items[key]; ok && e.owner == token {
				delete(m.items, key)
			}
		})
	}
	return release, true, nil
}

func (m *Memory) Close() error {
	m.stopped.Do(func() { close(m.stop) })
	return nil
}

func encodeInt(n int64) []byte {
	var b [8]byte
	for i := 7; i >= 0; i-- {
		b[i] = byte(n)
		n >>= 8
	}
	return b[:]
}

func decodeInt(b []byte) int64 {
	if len(b) != 8 {
		return 0
	}
	var n int64
	for _, x := range b {
		n = n<<8 | int64(x)
	}
	return n
}
