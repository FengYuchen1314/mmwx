package mieru

import (
	"encoding/hex"
	"testing"
)

// 参考值由独立的 Python hashlib 按 docs/protocol.md 计算(净室验证:对规范数学,非对 GPL 源码)。
func TestKeyDerivationVectors(t *testing.T) {
	username, password := "alice", "secret123"

	hp := hashPassword(username, password)
	if got := hex.EncodeToString(hp); got != "81a3876e94d50e07349ac35cef40e56ccc788c9ad7332bfe787274a7290bcd37" {
		t.Errorf("hashedPassword = %s", got)
	}

	// t=1700000000 → round-half-up 到 120s = 1700000040
	if got := roundedUnixTime(1700000000); got != 1700000040 {
		t.Errorf("roundedUnixTime = %d, want 1700000040", got)
	}

	salt := timeSalt(1700000040)
	if got := hex.EncodeToString(salt); got != "a93a74ae995047bb8ec3d7f2584a97d4bfffe25c81d83d19552e1bee60cda822" {
		t.Errorf("timeSalt = %s", got)
	}

	key, err := deriveKey(hp, salt)
	if err != nil {
		t.Fatalf("deriveKey: %v", err)
	}
	if got := hex.EncodeToString(key); got != "1d83a6eae63b9ae124b765ac2cee32f85181a5886246349e490e23ad892429aa" {
		t.Errorf("key = %s", got)
	}
}

func TestUserTagVector(t *testing.T) {
	nonce := make([]byte, nonceLen)
	for i := 0; i < nonceHeadLen; i++ {
		nonce[i] = byte(i) // 00..0f
	}
	tag := userTag("alice", nonce)
	if got := hex.EncodeToString(tag[:]); got != "4e3b9a70" {
		t.Errorf("userTag = %s, want 4e3b9a70", got)
	}

	// applyUserTag 后,nonceMatchesUser 应命中该用户、不命中他人
	applyUserTag(nonce, "alice")
	if !nonceMatchesUser("alice", nonce) {
		t.Error("applyUserTag 后应命中 alice")
	}
	if nonceMatchesUser("bob", nonce) {
		t.Error("不应命中 bob")
	}
}

func TestAEADRoundTrip(t *testing.T) {
	hp := hashPassword("u", "p")
	key, _ := deriveKey(hp, timeSalt(roundedUnixTime(1700000000)))
	aead, err := newAEAD(key)
	if err != nil {
		t.Fatalf("newAEAD: %v", err)
	}
	nonce := make([]byte, nonceLen)
	applyUserTag(nonce, "u")
	msg := []byte("hello mieru")
	ct := aead.Seal(nil, nonce, msg, nil)
	pt, err := aead.Open(nil, nonce, ct, nil)
	if err != nil || string(pt) != string(msg) {
		t.Fatalf("AEAD round-trip 失败: %v", err)
	}
}

func TestIncrementNonce(t *testing.T) {
	n := make([]byte, nonceLen)
	n[nonceLen-1] = 0xff
	incrementNonce(n) // 进位
	if n[nonceLen-1] != 0x00 || n[nonceLen-2] != 0x01 {
		t.Errorf("进位错误: %x", n)
	}
}

func TestCandidateRoundedTimes(t *testing.T) {
	c := candidateRoundedTimes(1700000040)
	// 应含 rounded、rounded-120、rounded+120
	if c[0] != 1700000040 || c[1] != 1700000040-120 || c[2] != 1700000040+120 {
		t.Errorf("candidates = %v", c)
	}
}
