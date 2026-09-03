// Package mieru 是 mieru 代理协议的**净室(clean-room)实现**,仅依据其公开协议规范
// (github.com/enfein/mieru docs/protocol.md)编写,不引用/不复制上游 GPL 源码。
// 本包实现 mieru **入站(server)**,与真实 mieru / mihomo 客户端互通验证。
//
// crypto.go:密钥派生与 AEAD。规范要点:
//   - hashedPassword = SHA256(password ‖ 0x00 ‖ username)
//   - timeSalt       = SHA256(uint64_be(unixTime 取整到最近 2 分钟))
//   - key            = PBKDF2-HMAC-SHA256(hashedPassword, timeSalt, iter=64, len=32)
//   - AEAD           = XChaCha20-Poly1305(key),nonce 24 字节
//   - 用户查找加速:nonce 末 4 字节 = SHA256(username ‖ nonce[:16])[:4]
//   - 服务端为时钟偏移最多试 3 个 timeSalt(rounded-120 / rounded / rounded+120)
package mieru

import (
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/binary"

	"golang.org/x/crypto/chacha20poly1305"
)

const (
	keyLen        = 32 // XChaCha20-Poly1305 key
	nonceLen      = 24 // XChaCha20-Poly1305 nonce
	pbkdf2Iter    = 64
	saltRoundSecs = 120 // 取整到最近 2 分钟
	userTagLen    = 4   // nonce 末 4 字节用户标签
	nonceHeadLen  = 16  // 参与用户标签计算的 nonce 前缀长度
)

// hashPassword 计算 hashedPassword = SHA256(password ‖ 0x00 ‖ username)。
func hashPassword(username, password string) []byte {
	h := sha256.New()
	h.Write([]byte(password))
	h.Write([]byte{0x00})
	h.Write([]byte(username))
	return h.Sum(nil)
}

// roundedUnixTime 把 unix 秒取整到最近的 120 秒(四舍五入,半值向上)。
func roundedUnixTime(unixSec int64) int64 {
	return ((unixSec + saltRoundSecs/2) / saltRoundSecs) * saltRoundSecs
}

// timeSalt = SHA256(uint64_be(roundedUnixSec))。
func timeSalt(roundedUnixSec int64) []byte {
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], uint64(roundedUnixSec))
	s := sha256.Sum256(b[:])
	return s[:]
}

// candidateRoundedTimes 返回服务端试解用的 3 个取整时间(覆盖 ±2min 时钟偏移)。
func candidateRoundedTimes(nowUnixSec int64) [3]int64 {
	r := roundedUnixTime(nowUnixSec)
	return [3]int64{r, r - saltRoundSecs, r + saltRoundSecs}
}

// deriveKey = PBKDF2-HMAC-SHA256(hashedPassword, timeSalt, 64, 32)。
func deriveKey(hashedPassword, salt []byte) ([]byte, error) {
	return pbkdf2.Key(sha256.New, string(hashedPassword), salt, pbkdf2Iter, keyLen)
}

// newAEAD 返回 XChaCha20-Poly1305 AEAD(nonce 24 字节)。
func newAEAD(key []byte) (cipher.AEAD, error) {
	return chacha20poly1305.NewX(key)
}

// userTag = SHA256(username ‖ nonce[:16])[:4],用于服务端在多用户中快速定位候选用户。
func userTag(username string, nonce []byte) [userTagLen]byte {
	h := sha256.New()
	h.Write([]byte(username))
	h.Write(nonce[:nonceHeadLen])
	sum := h.Sum(nil)
	var tag [userTagLen]byte
	copy(tag[:], sum[:userTagLen])
	return tag
}

// nonceMatchesUser 判断 nonce 末 4 字节是否等于某用户的 userTag(服务端定位候选用户)。
func nonceMatchesUser(username string, nonce []byte) bool {
	tag := userTag(username, nonce)
	return string(tag[:]) == string(nonce[nonceLen-userTagLen:nonceLen])
}

// applyUserTag 把 nonce 末 4 字节写成 username 的 userTag(发送方生成首个 nonce 时用)。
func applyUserTag(nonce []byte, username string) {
	tag := userTag(username, nonce)
	copy(nonce[nonceLen-userTagLen:nonceLen], tag[:])
}

// incrementNonce 把 24 字节 nonce 视为大端整数 +1(每次加密操作后调用)。
func incrementNonce(nonce []byte) {
	for i := len(nonce) - 1; i >= 0; i-- {
		nonce[i]++
		if nonce[i] != 0 {
			return
		}
	}
}
