package handler

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"errors"
	"fmt"

	"golang.org/x/crypto/scrypt"
)

// 仅用于读取历史版本生成的密码备份。新备份仍是无密码普通 ZIP。
var legacyBackupMagic = []byte("MMWXBKP1")

const (
	legacyBackupSaltLen  = 16
	legacyBackupNonceLen = 12
)

func isLegacyEncryptedBackup(data []byte) bool {
	return len(data) >= len(legacyBackupMagic) && bytes.Equal(data[:len(legacyBackupMagic)], legacyBackupMagic)
}

func decryptLegacyBackup(data []byte, passphrase string) ([]byte, error) {
	headerLen := len(legacyBackupMagic) + legacyBackupSaltLen + legacyBackupNonceLen
	if len(data) < headerLen+16 {
		return nil, errors.New("旧版加密备份已损坏或格式不完整")
	}
	off := len(legacyBackupMagic)
	salt := data[off : off+legacyBackupSaltLen]
	off += legacyBackupSaltLen
	nonce := data[off : off+legacyBackupNonceLen]
	off += legacyBackupNonceLen
	key, err := scrypt.Key([]byte(passphrase), salt, 1<<15, 8, 1, 32)
	if err != nil {
		return nil, fmt.Errorf("derive legacy backup key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, nonce, data[off:], legacyBackupMagic)
	if err != nil {
		return nil, errors.New("旧版备份解密失败：密码错误或文件已损坏")
	}
	return plain, nil
}
